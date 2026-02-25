// synctex parser and bidirectional sync
// vendored from LaTeX-Workshop synctexjs.ts (MIT, (c) 2018 Thomas Durieux)
// forward/reverse sync adapted from LaTeX-Workshop worker.ts

// -- types --

export type Block = {
  type: string;
  parent: Block | Page;
  fileNumber: number;
  file: InputFile;
  line: number;
  left: number;
  bottom: number;
  width: number | undefined;
  height: number;
  depth?: number;
  blocks?: Block[];
  elements?: Block[];
  page: number;
};

type InputFile = { path: string };
type InputFiles = { [fileNumber: string]: InputFile };
type Page = { page: number; blocks: Block[]; type: string };
type Pages = { [pageNum: string]: Page };
type BlockNumberLine = {
  [inputFileFullPath: string]: {
    [inputLineNum: number]: {
      [pageNum: number]: Block[];
    };
  };
};

export type PdfSyncObject = {
  offset: { x: number; y: number };
  version: string;
  files: InputFiles;
  pages: Pages;
  blockNumberLine: BlockNumberLine;
  hBlocks: Block[];
  numberPages: number;
};

export type SyncToPdfResult = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SyncToCodeResult = {
  file: string;
  line: number;
};

// -- gzip decompression (with plain-text fallback) --

function bytes_to_latin1(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

export async function decompress_gzip(data: Uint8Array): Promise<string> {
  if (data.length === 0) return "";
  // check gzip magic bytes; if not gzip, treat as plain text
  if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) {
    return bytes_to_latin1(data);
  }
  const ds = new DecompressionStream("gzip");
  const blob = new Blob([data as BlobPart]);
  const stream = blob.stream().pipeThrough(ds);
  const decompressed = await new Response(stream).arrayBuffer();
  return bytes_to_latin1(new Uint8Array(decompressed));
}

// -- parser (from synctexjs.ts) --

function is_block(b: Block | Page): b is Block {
  return (b as Block).parent !== undefined;
}

export function parse_synctex(body: string): PdfSyncObject | undefined {
  const unit = 65781.76;
  let number_pages = 0;
  let current_page: Page | undefined;
  let current_element: Block | Page | undefined;

  const block_number_line: BlockNumberLine = Object.create(null);
  const h_blocks: Block[] = [];
  const files: InputFiles = Object.create(null);
  const pages: Pages = Object.create(null);

  const obj: PdfSyncObject = {
    offset: { x: 0, y: 0 },
    version: "",
    files: Object.create(null),
    pages: Object.create(null),
    blockNumberLine: Object.create(null),
    hBlocks: [],
    numberPages: 0,
  };

  if (!body) return obj;
  const lines = body.split("\n");
  obj.version = lines[0].replace("SyncTeX Version:", "");

  const input_pat = /Input:([0-9]+):(.+)/;
  const offset_pat = /(X|Y) Offset:([0-9]+)/;
  const open_page = /\{([0-9]+)$/;
  const close_page = /\}([0-9]+)$/;
  const v_block = /\[([0-9]+),([0-9]+):(-?[0-9]+),(-?[0-9]+):(-?[0-9]+),(-?[0-9]+),(-?[0-9]+)/;
  const close_v = /\]$/;
  const h_block = /\(([0-9]+),([0-9]+):(-?[0-9]+),(-?[0-9]+):(-?[0-9]+),(-?[0-9]+),(-?[0-9]+)/;
  const close_h = /\)$/;
  const elem_pat = /(.)([0-9]+),([0-9]+):(-?[0-9]+),(-?[0-9]+)(:?(-?[0-9]+))?/;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    let m = line.match(input_pat);
    if (m) {
      files[m[1]] = { path: m[2] };
      continue;
    }

    m = line.match(offset_pat);
    if (m) {
      if (m[1].toLowerCase() === "x") obj.offset.x = parseInt(m[2]) / unit;
      else if (m[1].toLowerCase() === "y") obj.offset.y = parseInt(m[2]) / unit;
      else return undefined;
      continue;
    }

    m = line.match(open_page);
    if (m) {
      current_page = { page: parseInt(m[1]), blocks: [], type: "page" };
      if (current_page.page > number_pages) number_pages = current_page.page;
      current_element = current_page;
      continue;
    }

    m = line.match(close_page);
    if (m && current_page) {
      pages[m[1]] = current_page;
      current_page = undefined;
      continue;
    }

    m = line.match(v_block);
    if (m) {
      if (!current_page || !current_element) continue;
      const block: Block = {
        type: "vertical",
        parent: current_element,
        fileNumber: parseInt(m[1]),
        file: files[m[1]],
        line: parseInt(m[2]),
        left: Number(m[3]) / unit,
        bottom: Number(m[4]) / unit,
        width: Number(m[5]) / unit,
        height: Number(m[6]) / unit,
        depth: parseInt(m[7]),
        blocks: [],
        elements: [],
        page: current_page.page,
      };
      current_element = block;
      continue;
    }

    m = line.match(close_v);
    if (m) {
      if (current_element && is_block(current_element) && is_block(current_element.parent) && current_element.parent.blocks) {
        current_element.parent.blocks.push(current_element);
        current_element = current_element.parent;
      }
      continue;
    }

    m = line.match(h_block);
    if (m) {
      if (!current_page || !current_element) continue;
      const block: Block = {
        type: "horizontal",
        parent: current_element,
        fileNumber: parseInt(m[1]),
        file: files[m[1]],
        line: parseInt(m[2]),
        left: Number(m[3]) / unit,
        bottom: Number(m[4]) / unit,
        width: Number(m[5]) / unit,
        height: Number(m[6]) / unit,
        blocks: [],
        elements: [],
        page: current_page.page,
      };
      h_blocks.push(block);
      current_element = block;
      continue;
    }

    m = line.match(close_h);
    if (m) {
      if (current_element && is_block(current_element) && is_block(current_element.parent) && current_element.parent.blocks) {
        current_element.parent.blocks.push(current_element);
        current_element = current_element.parent;
      }
      continue;
    }

    m = line.match(elem_pat);
    if (m) {
      if (!current_page || !current_element || !is_block(current_element)) continue;
      const file_number = parseInt(m[2]);
      const line_number = parseInt(m[3]);
      const elem: Block = {
        type: m[1],
        parent: current_element,
        fileNumber: file_number,
        file: files[file_number],
        line: line_number,
        left: Number(m[4]) / unit,
        bottom: Number(m[5]) / unit,
        height: current_element.height,
        width: m[7] ? Number(m[7]) / unit : undefined,
        page: current_page.page,
      };
      if (!elem.file) continue;
      const path = elem.file.path;
      if (!block_number_line[path]) block_number_line[path] = Object.create(null);
      if (!block_number_line[path][line_number]) block_number_line[path][line_number] = Object.create(null);
      if (!block_number_line[path][line_number][elem.page]) block_number_line[path][line_number][elem.page] = [];
      block_number_line[path][line_number][elem.page].push(elem);
      if (current_element.elements) current_element.elements.push(elem);
      continue;
    }
  }

  obj.files = files;
  obj.pages = pages;
  obj.blockNumberLine = block_number_line;
  obj.hBlocks = h_blocks;
  obj.numberPages = number_pages;
  return obj;
}

// -- rectangle helper --

class Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;

  constructor(top: number, bottom: number, left: number, right: number) {
    this.top = top;
    this.bottom = bottom;
    this.left = left;
    this.right = right;
  }

  contains(px: number, py: number): boolean {
    return px >= this.left && px <= this.right && py >= this.top && py <= this.bottom;
  }

  area(): number {
    return (this.right - this.left) * (this.bottom - this.top);
  }

  // minimum distance from point to rectangle edge (0 when point is inside)
  distance_to_point(px: number, py: number): number {
    const dx = Math.max(this.left - px, 0, px - this.right);
    const dy = Math.max(this.top - py, 0, py - this.bottom);
    return Math.sqrt(dx * dx + dy * dy);
  }
}

function block_to_rect(b: Block): Rect {
  return new Rect(b.bottom - b.height, b.bottom, b.left, b.width ? b.left + b.width : b.left);
}

function blocks_to_rect(blocks: Block[]): Rect {
  let top = 2e16, bottom = 0, left = 2e16, right = 0;
  for (const b of blocks) {
    if (b.elements !== undefined || b.type === "k" || b.type === "r") continue;
    bottom = Math.max(b.bottom, bottom);
    top = Math.min(b.bottom - b.height, top);
    left = Math.min(b.left, left);
    if (b.width !== undefined) right = Math.max(b.left + b.width, right);
  }
  return new Rect(top, bottom, left, right);
}

// -- path normalization --
// synctex records WASI paths like ./main.tex or //main.tex -- strip leading ./ and /
function normalize_path(p: string): string {
  return p.replace(/^[./]+/, "");
}

function find_input_path(data: PdfSyncObject, file: string): string | undefined {
  const normalized = normalize_path(file);
  for (const input_path in data.blockNumberLine) {
    if (normalize_path(input_path) === normalized) return input_path;
  }
  // case-insensitive fallback
  const lower = normalized.toLowerCase();
  for (const input_path in data.blockNumberLine) {
    if (normalize_path(input_path).toLowerCase() === lower) return input_path;
  }
  return undefined;
}

// -- forward sync: editor -> PDF --

function get_blocks_for_line(line_page_blocks: { [line: number]: { [page: number]: Block[] } }, line: number): Block[] {
  const page_blocks = line_page_blocks[line];
  const page_nums = Object.keys(page_blocks);
  if (page_nums.length === 0) return [];
  return page_blocks[Number(page_nums[0])];
}

export function sync_to_pdf(data: PdfSyncObject, file: string, line: number): SyncToPdfResult | null {
  const input_path = find_input_path(data, file);
  if (!input_path) {
    if (import.meta.env.DEV) console.debug("[synctex:forward] no input path found for file", file);
    return null;
  }

  const line_page_blocks = data.blockNumberLine[input_path];
  const line_nums = Object.keys(line_page_blocks).map(Number).sort((a, b) => a - b);
  if (line_nums.length === 0) return null;

  const i = line_nums.findIndex((x) => x >= line);

  let blocks: Block[];
  let rect: Rect;

  if (i < 0) {
    // line is past the last known line -- use last
    const last = line_nums[line_nums.length - 1];
    blocks = get_blocks_for_line(line_page_blocks, last);
    rect = blocks_to_rect(blocks);
  } else if (i === 0 || line_nums[i] === line) {
    blocks = get_blocks_for_line(line_page_blocks, line_nums[i]);
    rect = blocks_to_rect(blocks);
  } else {
    // interpolate between bounding lines
    const l0 = line_nums[i - 1];
    const l1 = line_nums[i];
    const b0 = get_blocks_for_line(line_page_blocks, l0);
    const b1 = get_blocks_for_line(line_page_blocks, l1);
    const r0 = blocks_to_rect(b0);
    const r1 = blocks_to_rect(b1);
    blocks = b1;
    const bottom = r0.bottom < r1.bottom
      ? r0.bottom * (l1 - line) / (l1 - l0) + r1.bottom * (line - l0) / (l1 - l0)
      : r1.bottom;
    rect = new Rect(r1.top, bottom, r1.left, r1.right);
  }

  if (blocks.length === 0) return null;

  const raw_height = rect.bottom - rect.top;
  const raw_width = rect.right - rect.left;

  // reject degenerate bounding boxes (preamble lines, unmatched content)
  // that span most of the page -- no meaningful typeset region to highlight
  if (raw_height > 200) {
    if (import.meta.env.DEV) console.debug("[synctex:forward] sync_to_pdf rejected (degenerate height)", { file, line, raw_height });
    return null;
  }

  // clamp small boxes to readable minimum sizes:
  // single-character records produce ~10pt boxes, make them visible
  const width = Math.max(raw_width, 50);
  const height = Math.max(raw_height, 12);

  const result: SyncToPdfResult = {
    page: blocks[0].page,
    x: rect.left + data.offset.x,
    y: rect.bottom + data.offset.y,
    width,
    height,
  };
  if (import.meta.env.DEV) console.debug("[synctex:forward] sync_to_pdf", { file, line, input_path, rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }, offset: data.offset, result });
  return result;
}

// -- reverse sync: PDF click -> editor --

export function sync_to_code(data: PdfSyncObject, page: number, x: number, y: number): SyncToCodeResult | null {
  const x0 = x - data.offset.x;
  const y0 = y - data.offset.y;
  if (import.meta.env.DEV) console.debug("[synctex:reverse] sync_to_code input", { page, x, y, offset: data.offset, adjusted: { x0, y0 } });

  // collect all candidate blocks on this page
  type Candidate = { file: string; line: number; rect: Rect };
  const candidates: Candidate[] = [];

  for (const file_name in data.blockNumberLine) {
    const line_page_blocks = data.blockNumberLine[file_name];
    for (const line_num_str in line_page_blocks) {
      const page_blocks = line_page_blocks[Number(line_num_str)];
      for (const page_num_str in page_blocks) {
        if (page !== Number(page_num_str)) continue;
        const blocks = page_blocks[Number(page_num_str)];
        for (const block of blocks) {
          if (block.elements !== undefined || block.type === "k" || block.type === "r") continue;
          candidates.push({ file: file_name, line: Number(line_num_str), rect: block_to_rect(block) });
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  if (import.meta.env.DEV) console.debug("[synctex:reverse] candidates", candidates.map(c => ({
    line: c.line, rect: { left: c.rect.left.toFixed(1), top: c.rect.top.toFixed(1), right: c.rect.right.toFixed(1), bottom: c.rect.bottom.toFixed(1) },
    contains: c.rect.contains(x0, y0), dist: c.rect.distance_to_point(x0, y0).toFixed(2),
  })));

  // pass 1: find smallest containing rect (innermost block that contains the click)
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (!c.rect.contains(x0, y0)) continue;
    if (!best || c.rect.area() < best.rect.area()) best = c;
  }

  // pass 2 fallback: vertical-priority distance metric.
  // synctex y-coordinates (baselines) are highly reliable, but x-coordinates
  // often don't cover the full rendered text width (especially for section headings,
  // where individual character boxes are recorded). weight vertical distance 3x
  // to strongly prefer blocks on the same visual line over horizontally-closer
  // blocks on different lines. this matches LaTeX-Workshop's behavior.
  if (!best) {
    let best_dist = Infinity;
    for (const c of candidates) {
      const dx = Math.max(c.rect.left - x0, 0, x0 - c.rect.right);
      const dy = Math.max(c.rect.top - y0, 0, y0 - c.rect.bottom);
      const dist = dx + 3 * dy;
      if (dist < best_dist) {
        best_dist = dist;
        best = c;
      }
    }
  }

  if (!best) return null;
  if (import.meta.env.DEV) console.debug("[synctex:reverse] sync_to_code result", { file: normalize_path(best.file), line: best.line, dist: best.rect.distance_to_point(x0, y0) });
  return { file: normalize_path(best.file), line: best.line };
}
