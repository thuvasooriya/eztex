/**
 * CORS Proxy for ITAR Bundle Server + Collaboration Room Authority
 *
 * Routes:
 *   GET /               -- health check
 *   GET /bundle         -- R2 primary, Tectonic fallback (2.8GB tar, Range requests)
 *   GET /index.gz       -- R2 primary, Tectonic fallback (1.2MB gzipped index)
 *   GET /formats/*      -- R2 only (23MB .fmt files)
 *   GET /collab/health  -- collab health check
 *   GET /collab/ws/*    -- WebSocket upgrade to Durable Object room
 *   OPTIONS *           -- CORS preflight
 */

import { CollabRoom } from './collab_room.js';

// upstream Tectonic bundle (fallback origin)
const TECTONIC_BUNDLE_URL = 'https://relay.fullyjustified.net/default_bundle_v33.tar';
const TECTONIC_INDEX_URL = TECTONIC_BUNDLE_URL + '.index.gz';

// R2 object keys
const R2_BUNDLE_KEY = 'tlextras-2022.0r0.tar';
const R2_INDEX_KEY = 'tlextras-2022.0r0.tar.index.gz';

const FORMAT_PREFIX = '/formats/';
const BUNDLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const FORMAT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Allowed origins for CORS
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:3000',
  'https://eztex-cors-proxy.thuva.workers.dev',
  'https://eztex.thuva.workers.dev',
  'https://eztex.pages.dev',
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return handleCORS(request);
    }

    const path = url.pathname;

    // collaboration routes
    if (path === '/collab/health') {
      return new Response(JSON.stringify({ status: 'ok', collab: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request) },
      });
    }

    if (path.startsWith('/collab/ws/')) {
      const room_id = path.slice('/collab/ws/'.length);
      if (!room_id) {
        return new Response('Room ID required', { status: 400 });
      }
      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const id = env.COLLAB_ROOM.idFromName(room_id);
      const room = env.COLLAB_ROOM.get(id);
      return room.fetch(request);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { 'Cache-Control': 'no-store', ...corsHeaders(request) },
      });
    }

    if (path === '/' || path === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        routes: {
          '/bundle': 'tar file (R2 primary, Tectonic fallback)',
          '/index.gz': 'gzipped index (R2 primary, Tectonic fallback)',
          '/formats/*': 'precompiled format files from R2',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request) },
      });
    }

    if (path === '/index.gz' || path === '/index') {
      // try edge cache first
      const cached = await getCachedIndex(request);
      if (cached) return cached;

      const response = await serveR2OrFallback(request, env, R2_INDEX_KEY, TECTONIC_INDEX_URL, 'application/gzip', ctx);
      // cache only full 200 responses (Cache API rejects 206)
      if (response.status === 200) {
        ctx.waitUntil(cacheIndexResponse(request, response));
      }
      return response;
    }

    if (path === '/bundle' || path === '/bundle/') {
      return serveR2OrFallback(request, env, R2_BUNDLE_KEY, TECTONIC_BUNDLE_URL, 'application/octet-stream', ctx);
    }

    if (path.startsWith(FORMAT_PREFIX)) {
      return handleFormatRequest(request, env, path);
    }

    return new Response('Not found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store', ...corsHeaders(request) },
    });
  },
};

// edge-cache the index response
async function getCachedIndex(request) {
  try {
    const cache = caches.default;
    const cacheKey = new Request(request.url, { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) {
      console.log('index cache hit');
      return cached;
    }
  } catch (err) {
    console.error('Cache match error:', err);
  }
  return null;
}

async function cacheIndexResponse(request, response) {
  try {
    const cache = caches.default;
    const cacheKey = new Request(request.url, { method: 'GET' });
    await cache.put(cacheKey, response.clone());
  } catch (err) {
    console.error('Cache put error:', err);
  }
}

// validate Range header format
function validateRange(rangeHeader) {
  if (!rangeHeader) return { valid: true };
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return { valid: false, reason: 'invalid syntax' };
  const start = match[1] ? parseInt(match[1], 10) : null;
  const end = match[2] ? parseInt(match[2], 10) : null;
  // both empty: bytes=- is invalid
  if (start === null && end === null) {
    return { valid: false, reason: 'both start and end are empty' };
  }
  if (start !== null && end !== null && start > end) {
    return { valid: false, reason: 'unsatisfiable range' };
  }
  return { valid: true };
}

// determine conditional status: 304 for validators, 412 for preconditions
function conditionalStatus(request) {
  if (request.headers.has('If-Match') || request.headers.has('If-Unmodified-Since')) {
    return 412;
  }
  return 304;
}

// serve from R2, fallback to Tectonic proxy on failure
async function serveR2OrFallback(request, env, r2Key, fallbackUrl, contentType, ctx) {
  // validate Range header before hitting R2
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const rangeCheck = validateRange(rangeHeader);
    if (!rangeCheck.valid) {
      console.warn(`Bad Range header: "${rangeHeader}" -- ${rangeCheck.reason}`);
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', ...corsHeaders(request) },
      });
    }
  }

  try {
    // for HEAD without conditionals, use head() to avoid body work
    const hasConditionals = ['If-None-Match', 'If-Modified-Since', 'If-Match', 'If-Unmodified-Since', 'If-Range'].some(
      h => request.headers.has(h)
    );
    const isHead = request.method === 'HEAD';

    let object;
    const usedHead = isHead && !hasConditionals;
    if (usedHead) {
      object = await env.ASSETS.head(r2Key);
    } else {
      object = await env.ASSETS.get(r2Key, {
        range: request.headers,
        onlyIf: request.headers,
      });
    }

    if (object !== null) {
      const headers = new Headers();
      if (object.writeHttpMetadata) {
        object.writeHttpMetadata(headers);
      }
      headers.set('Content-Type', contentType);
      headers.set('Cache-Control', BUNDLE_CACHE_CONTROL);
      headers.set('Accept-Ranges', 'bytes');
      if (object.httpEtag) headers.set('ETag', object.httpEtag);
      if (object.uploaded) headers.set('Last-Modified', object.uploaded.toUTCString());

      for (const [key, value] of Object.entries(corsHeaders(request))) {
        headers.set(key, value);
      }

      // status logic:
      // - usedHead (unconditional HEAD): always 200
      // - has body: 200 or 206 depending on range
      // - no body (conditional failed): 304 or 412
      const hasBody = 'body' in object && object.body;
      const status = usedHead ? 200 : (hasBody ? (object.range ? 206 : 200) : conditionalStatus(request));

      if (object.range) {
        headers.set(
          'Content-Range',
          `bytes ${object.range.offset}-${object.range.end ?? object.size - 1}/${object.size}`,
        );
        headers.set('Content-Length', String(object.range.length));
      } else if (status !== 304) {
        headers.set('Content-Length', String(object.size));
      }

      return new Response(isHead ? null : object.body, { status, headers });
    }
  } catch (err) {
    console.error(`R2 read failed for ${r2Key}:`, err);
  }

  // fallback: proxy to Tectonic
  console.log(`R2 miss for ${r2Key}, falling back to Tectonic`);
  return proxyRequest(fallbackUrl, request, contentType, BUNDLE_CACHE_CONTROL);
}

async function proxyRequest(upstreamUrl, request, contentType, cacheControl) {
  const upstreamHeaders = new Headers();

  // forward all relevant conditional and range headers
  for (const name of ['Range', 'If-Range', 'If-None-Match', 'If-Modified-Since', 'If-Match', 'If-Unmodified-Since']) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }

  try {
    const response = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
    });

    const responseHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(request))) {
      responseHeaders.set(key, value);
    }

    // normalize cache and content type on fallback
    if (contentType) responseHeaders.set('Content-Type', contentType);
    if (cacheControl) responseHeaders.set('Cache-Control', cacheControl);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return new Response('Proxy error', {
      status: 502,
      headers: { 'Cache-Control': 'no-store', ...corsHeaders(request) },
    });
  }
}

async function handleFormatRequest(request, env, path) {
  const key = path.slice(1);

  if (key === 'formats' || key === 'formats/') {
    return formatNotFound(request);
  }

  try {
    const hasConditionals = ['If-None-Match', 'If-Modified-Since', 'If-Match', 'If-Unmodified-Since', 'If-Range'].some(
      h => request.headers.has(h)
    );
    const isHead = request.method === 'HEAD';

    let object;
    if (isHead && !hasConditionals) {
      object = await env.ASSETS.head(key);
    } else {
      object = await env.ASSETS.get(key, {
        range: request.headers,
        onlyIf: request.headers,
      });
    }

    if (object === null) {
      return formatNotFound(request);
    }

    const headers = buildFormatHeaders(object, request);
    const hasBody = 'body' in object && object.body;
    const status = hasBody ? (object.range ? 206 : 200) : conditionalStatus(request);

    if (object.range) {
      headers.set(
        'Content-Range',
        `bytes ${object.range.offset}-${object.range.end ?? object.size - 1}/${object.size}`,
      );
      headers.set('Content-Length', String(object.range.length));
    } else if (status !== 304) {
      headers.set('Content-Length', String(object.size));
    }

    return new Response(isHead ? null : object.body, {
      status,
      headers,
    });
  } catch (error) {
    console.error('Format fetch error:', error);
    return new Response('Format fetch error', {
      status: 502,
      headers: { 'Cache-Control': 'no-store', ...corsHeaders(request) },
    });
  }
}

function buildFormatHeaders(object, request) {
  const headers = new Headers();
  if (object.writeHttpMetadata) {
    object.writeHttpMetadata(headers);
  }
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('Cache-Control', object.httpMetadata?.cacheControl ?? FORMAT_CACHE_CONTROL);
  headers.set('Accept-Ranges', 'bytes');
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  if (object.uploaded) headers.set('Last-Modified', object.uploaded.toUTCString());

  for (const [key, value] of Object.entries(corsHeaders(request))) {
    headers.set(key, value);
  }

  return headers;
}

function formatNotFound(request) {
  return new Response('Format not found', {
    status: 404,
    headers: { 'Cache-Control': 'no-store', ...corsHeaders(request) },
  });
}

function handleCORS(request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request),
      'Access-Control-Max-Age': '86400',
    },
  });
}

function corsHeaders(request) {
  const origin = request?.headers?.get?.('Origin') ?? '*';
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : (ALLOWED_ORIGINS.size === 0 ? '*' : null);

  if (!allowed) {
    return { 'Vary': 'Origin' };
  }

  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, If-Range, Content-Type, If-Modified-Since, If-None-Match, If-Match, If-Unmodified-Since',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified',
    'Vary': 'Origin',
  };
}
