// upload-r2.ts -- upload a file to Cloudflare R2 using Bun's native S3 client.
//
// usage:
//   bun run upload-r2.ts <local-file> <object-key>
//
// examples:
//   bun run upload-r2.ts assets/xelatex_v33_wasm32-wasi_c1607948053fc5d4.fmt formats/xelatex_v33_wasm32-wasi_c1607948053fc5d4.fmt
//
// required env vars:
//   R2_ACCOUNT_ID      -- Cloudflare account ID (32-char hex)
//   R2_ACCESS_KEY_ID   -- R2 API token access key
//   R2_SECRET_KEY      -- R2 API token secret key

const BUCKET = "eztex-assets";

if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
  console.log("usage: bun run upload-r2.ts <local-file> <object-key>");
  console.log();
  console.log("example:");
  console.log("  bun run upload-r2.ts assets/xelatex_v33_wasm32-wasi_c1607948053fc5d4.fmt formats/xelatex_v33_wasm32-wasi_c1607948053fc5d4.fmt");
  process.exit(0);
}

const filePath = Bun.argv[2];
const objectKey = Bun.argv[3];

if (!filePath || !objectKey) {
  console.error("error: both <local-file> and <object-key> are required");
  console.error("usage: bun run upload-r2.ts <local-file> <object-key>");
  console.error("       bun run upload-r2.ts --help for examples");
  process.exit(1);
}

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_KEY;
const endpointOverride = process.env.R2_SOME_URL;

if (!accessKeyId || !secretAccessKey) {
  console.error("error: missing required environment variables:");
  if (!accessKeyId) console.error("  R2_ACCESS_KEY_ID is not set");
  if (!secretAccessKey) console.error("  R2_SECRET_KEY is not set");
  process.exit(1);
}

const endpoint = endpointOverride ?? (accountId
  ? `https://${accountId}.r2.cloudflarestorage.com`
  : null);

if (!endpoint) {
  console.error("error: set either R2_ACCOUNT_ID or R2_SOME_URL to specify the R2 endpoint");
  process.exit(1);
}

console.log(`endpoint: ${endpoint}`);

const client = new Bun.S3Client({
  accessKeyId,
  secretAccessKey,
  endpoint,
  bucket: BUCKET,
});

const localFile = Bun.file(filePath);

if (!(await localFile.exists())) {
  console.error(`error: local file does not exist: ${filePath}`);
  process.exit(1);
}

const sizeGiB = (localFile.size / 1024 ** 3).toFixed(2);

console.log(`file:   ${filePath}`);
console.log(`size:   ${sizeGiB} GiB (${localFile.size.toLocaleString()} bytes)`);
console.log(`target: r2://${BUCKET}/${objectKey}`);
console.log();
console.log("uploading... (multipart, this will take a while)");

const start = Date.now();
await client.write(objectKey, localFile);
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

// verify
const stat = await client.stat(objectKey);
const uploadedGiB = (stat.size / 1024 ** 3).toFixed(2);

console.log();
console.log(`done in ${elapsed}s`);
console.log(`verified: ${uploadedGiB} GiB at r2://${BUCKET}/${objectKey}`);
