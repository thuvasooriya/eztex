// verify-r2.ts -- check what bundle/index objects exist in R2 without downloading

import { S3Client } from "bun";

const BUCKET = "eztex-assets";

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_KEY;
const endpointOverride = process.env.R2_SOME_URL;

if (!accessKeyId || !secretAccessKey) {
  console.error("Missing R2_ACCESS_KEY_ID or R2_SECRET_KEY");
  process.exit(1);
}

const endpoint = endpointOverride ?? (accountId
  ? `https://${accountId}.r2.cloudflarestorage.com`
  : null);

if (!endpoint) {
  console.error("Missing R2 endpoint");
  process.exit(1);
}

const client = new S3Client({
  accessKeyId,
  secretAccessKey,
  endpoint,
  bucket: BUCKET,
});

async function checkObject(key: string) {
  try {
    const stat = await client.stat(key);
    if (stat) {
      console.log(`  EXISTS: ${key}`);
      console.log(`    size: ${stat.size.toLocaleString()} bytes (${(stat.size / 1024 ** 3).toFixed(2)} GB)`);
      console.log(`    etag: ${stat.etag}`);
      console.log(`    lastModified: ${stat.lastModified}`);
      return true;
    }
  } catch (err: any) {
    if (err.code === "NoSuchKey" || err.statusCode === 404) {
      console.log(`  MISSING: ${key}`);
    } else {
      console.log(`  ERROR: ${key} -- ${err.message || err}`);
    }
  }
  return false;
}

// -- check upstream bundle metadata --
console.log("Checking upstream bundle...");
try {
  const head = await fetch("https://relay.fullyjustified.net/default_bundle_v33.tar", { method: "HEAD" });
  console.log(`  Upstream HEAD status: ${head.status}`);
  if (head.headers.get("location")) {
    console.log(`  Redirects to: ${head.headers.get("location")}`);
  }
  const len = head.headers.get("content-length");
  if (len) {
    console.log(`  Upstream size: ${parseInt(len).toLocaleString()} bytes (${(parseInt(len) / 1024 ** 3).toFixed(2)} GB)`);
  }
} catch (e: any) {
  console.log(`  Upstream error: ${e.message}`);
}

// -- check R2 objects --
console.log("\nChecking R2 objects...");

const keys = [
  "tlextras-2022.0r0.tar",
  "bundles/default_bundle_v33.tar",
  "tlextras-2022.0r0.tar.index.gz",
  "bundles/default_bundle_v33.tar.index.gz",
  "formats/xelatex_v33_wasm32-wasi_c1607948053fc5d4.fmt",
];

for (const key of keys) {
  await checkObject(key);
}

// -- try listing --
console.log("\nTrying R2 list (prefix='')...");
try {
  const listResult = await client.list();
  if (listResult && listResult.contents) {
    console.log(`  Found ${listResult.contents.length} objects`);
    for (const obj of listResult.contents.slice(0, 10)) {
      console.log(`    ${obj.key}: ${obj.size?.toLocaleString()} bytes`);
    }
  } else {
    console.log("  No objects found or empty bucket");
  }
} catch (e: any) {
  console.log(`  List error: ${e.message || e}`);
}
