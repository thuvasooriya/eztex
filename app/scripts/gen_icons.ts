// gen_icons.ts -- generate favicon.svg, favicon.ico, apple-touch-icon.png from logo.svg
// usage: bun run app/scripts/gen_icons.ts
// requires: bunx @aspect-build/resvg (auto-installed on first run)

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const public_dir = join(import.meta.dirname, "..", "public");
const logo_path = join(public_dir, "logo.svg");
const tmp_dir = join(import.meta.dirname, "..", "..", "tmp");

execSync(`mkdir -p ${tmp_dir}`);

// extract the inner <path> elements from logo.svg (skip the <svg> wrapper)
const logo_src = readFileSync(logo_path, "utf-8");
const paths = logo_src
  .split("\n")
  .filter((l) => l.trim().startsWith("<path"))
  .join("\n");

// build a 1080x1080 icon SVG: rounded-rect background + logo paths
const icon_svg = `<svg viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
  <rect width="1080" height="1080" rx="194" ry="194" fill="#1a1b26"/>
${paths}
</svg>`;

// 1. favicon.svg = icon with background
const favicon_svg = join(public_dir, "favicon.svg");
writeFileSync(favicon_svg, icon_svg);
console.log("  -> favicon.svg");

// 2. apple-touch-icon.png (180x180)
const apple = join(public_dir, "apple-touch-icon.png");
execSync(`bunx @aspect-build/resvg "${favicon_svg}" "${apple}" -w 180 -h 180`);
console.log("  -> apple-touch-icon.png (180x180)");

// 3. favicon.ico (16x16 + 32x32 PNGs packed into ICO format)
const png16 = join(tmp_dir, "icon16.png");
const png32 = join(tmp_dir, "icon32.png");
execSync(`bunx @aspect-build/resvg "${favicon_svg}" "${png16}" -w 16 -h 16`);
execSync(`bunx @aspect-build/resvg "${favicon_svg}" "${png32}" -w 32 -h 32`);

function build_ico(images: { size: number; data: Buffer }[]): Buffer {
  const header_size = 6;
  const entry_size = 16;
  let data_offset = header_size + entry_size * images.length;

  const header = Buffer.alloc(header_size);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(images.length, 4);

  const parts: Buffer[] = [header];
  const data_parts: Buffer[] = [];

  for (const img of images) {
    const entry = Buffer.alloc(entry_size);
    entry.writeUInt8(img.size < 256 ? img.size : 0, 0);
    entry.writeUInt8(img.size < 256 ? img.size : 0, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(img.data.length, 8);
    entry.writeUInt32LE(data_offset, 12);
    parts.push(entry);
    data_parts.push(img.data);
    data_offset += img.data.length;
  }

  return Buffer.concat([...parts, ...data_parts]);
}

const ico_buf = build_ico([
  { size: 16, data: readFileSync(png16) },
  { size: 32, data: readFileSync(png32) },
]);
writeFileSync(join(public_dir, "favicon.ico"), ico_buf);
console.log("  -> favicon.ico (16x16 + 32x32)");

// cleanup temp files
execSync(`rm -f "${png16}" "${png32}"`);

console.log("done.");
