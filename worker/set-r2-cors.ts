/**
 * Sets CORS rules on the eztex-assets R2 bucket via Cloudflare API.
 * Credentials are read from .env (never hardcoded).
 *
 * Required env vars:
 *   R2_ACCOUNT_ID  -- Cloudflare account ID
 *   R2_USER_TOKEN  -- Cloudflare API token (needs R2:Edit permission)
 */

const BUCKET = "eztex-assets";

const accountId = process.env.R2_ACCOUNT_ID;
const token = process.env.R2_USER_TOKEN;

if (!accountId || !token) {
  console.error("missing R2_ACCOUNT_ID or R2_USER_TOKEN in environment");
  process.exit(1);
}

const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${BUCKET}/cors`;

// CORS rules needed for WASM + HTTP Range requests from any browser origin
const body = {
  rules: [
    {
      allowed: {
        origins: ["*"],
        methods: ["GET", "HEAD", "OPTIONS"],
        headers: ["Range", "Content-Type", "Authorization"],
      },
      exposeHeaders: [
        "Content-Length",
        "Content-Range",
        "Accept-Ranges",
        "ETag",
      ],
      maxAgeSeconds: 86400,
    },
  ],
};

// -- check current CORS first --
console.log("checking current CORS config...");
const getRes = await fetch(url, {
  method: "GET",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
});
const current = await getRes.json();
console.log("current:", JSON.stringify(current, null, 2));

// -- apply new CORS rules --
console.log("\napplying CORS rules...");
const putRes = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

const result = await putRes.json();
console.log("result:", JSON.stringify(result, null, 2));

if (!putRes.ok) {
  console.error(`failed: HTTP ${putRes.status}`);
  process.exit(1);
}

console.log("\ndone. verifying with preflight test...");

// -- verify: simulate browser OPTIONS preflight --
const preflightRes = await fetch(
  `https://pub-11eb5febbe2a463cb7312bac806cd88f.r2.dev/tlextras-2022.0r0.tar`,
  {
    method: "OPTIONS",
    headers: {
      Origin: "https://example.com",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "Range",
    },
  }
);

console.log(`preflight status: ${preflightRes.status}`);
for (const [k, v] of preflightRes.headers.entries()) {
  if (k.toLowerCase().startsWith("access-control")) {
    console.log(`  ${k}: ${v}`);
  }
}
