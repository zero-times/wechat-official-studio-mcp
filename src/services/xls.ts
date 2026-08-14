// Minimal reader for the legacy .xls (OLE2 + BIFF8) exports WeChat serves
// from /misc/appmsganalysis. Handles only the records Excel BIFF8 writers
// produce for these reports: inline LABEL strings, NUMBER doubles, and BLANK
// cells inside a single worksheet. Unknown records are skipped.
import { WechatMcpError } from "./errors.js";

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isOle2(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return OLE2_MAGIC.every((byte, index) => bytes[index] === byte);
}

type Ole2Header = {
  sectorSize: number;
  miniSectorSize: number;
  fatSectors: number;
  directoryStart: number;
  miniFatStart: number;
  miniFatSectors: number;
  difatStart: number;
  difatSectors: number;
};

function readHeader(bytes: Uint8Array): Ole2Header {
  return {
    sectorSize: 1 << readU16(bytes, 30),
    miniSectorSize: 1 << readU16(bytes, 32),
    fatSectors: readU32(bytes, 44),
    directoryStart: readU32(bytes, 48),
    miniFatStart: readU32(bytes, 60),
    miniFatSectors: readU32(bytes, 64),
    difatStart: readU32(bytes, 68),
    difatSectors: readU32(bytes, 72),
  };
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  );
}

const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;

export function parseOle2Streams(bytes: Uint8Array): Map<string, Uint8Array> {
  if (!isOle2(bytes)) {
    throw new WechatMcpError("INVALID_RESPONSE", "The response is not an OLE2 (.xls) file.");
  }
  const header = readHeader(bytes);
  const sectorSize = header.sectorSize;
  const sector = (number: number): Uint8Array =>
    bytes.subarray(512 + number * sectorSize, 512 + (number + 1) * sectorSize);

  // FAT sectors are listed in the header DIFAT array, chained through any
  // extended DIFAT sectors stored at the end of the file.
  const difat: number[] = [];
  for (let index = 0; index < 109; index += 1) {
    const entry = readU32(bytes, 76 + index * 4);
    if (entry !== FREE_SECTOR) difat.push(entry);
  }
  let next = header.difatStart;
  while (difat.length < header.fatSectors && next !== END_OF_CHAIN && next !== FREE_SECTOR) {
    const section = sector(next);
    for (let index = 0; index < sectorSize / 4 - 1; index += 1) difat.push(readU32(section, index * 4));
    next = readU32(section, sectorSize - 4);
  }
  const fat = difat.slice(0, header.fatSectors).map(sector);
  const fatEntry = (number: number): number => {
    const section = fat[Math.floor(number / (sectorSize / 4))];
    if (!section) return END_OF_CHAIN;
    return readU32(section, (number % (sectorSize / 4)) * 4);
  };

  const chain = (start: number, maxLength = 200_000): number[] => {
    const result: number[] = [];
    let current = start;
    while (current < END_OF_CHAIN && result.length < maxLength) {
      result.push(current);
      current = fatEntry(current);
    }
    return result;
  };

  const readStream = (start: number, size: number): Uint8Array => {
    if (size < header.miniSectorSize) {
      // Small streams live in the root entry's mini stream, indexed by the
      // mini FAT.
      let root;
      for (const dirSector of chain(header.directoryStart)) {
        const section = sector(dirSector);
        for (let offset = 0; offset < sectorSize; offset += 128) {
          if (section[offset + 66] === 5) {
            root = { start: readU32(section, offset + 116), size: readU32(section, offset + 120) };
            break;
          }
        }
        if (root) break;
      }
      if (!root) {
        throw new WechatMcpError("INVALID_RESPONSE", "The .xls file has no root stream entry.");
      }
      const miniStream = concat(chain(root.start).map(sector)).subarray(0, root.size);
      const miniFat = concat(chain(header.miniFatStart, header.miniFatSectors).map(sector));
      const miniEntry = (number: number): number => readU32(miniFat, number * 4);
      const miniChain: number[] = [];
      let current = start;
      while (current < END_OF_CHAIN && miniChain.length < 200_000) {
        miniChain.push(current);
        current = miniEntry(current);
      }
      return concat(
        miniChain.map((number) =>
          miniStream.subarray(number * header.miniSectorSize, (number + 1) * header.miniSectorSize),
        ),
      ).subarray(0, size);
    }
    return concat(chain(start).map(sector)).subarray(0, size);
  };

  const streams = new Map<string, Uint8Array>();
  for (const dirSector of chain(header.directoryStart)) {
    const section = sector(dirSector);
    for (let offset = 0; offset < sectorSize; offset += 128) {
      if (section[offset + 66] !== 2) continue;
      const name = utf16le(section.subarray(offset, offset + 64)).split("\u0000", 1)[0] ?? "";
      streams.set(name, readStream(readU32(section, offset + 116), readU32(section, offset + 120)));
    }
  }
  return streams;
}

function utf16le(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    result += String.fromCharCode(bytes[index]! | (bytes[index + 1]! << 8));
  }
  return result;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export type XlsSheet = {
  name?: string;
  // First meaningful text row (typically a title such as
  // "全部群发详细数据-日报（2025-10-01至2025-11-01）").
  title?: string;
  columns: string[];
  rows: (string | number | null)[][];
};

const RECORD_LABEL = 0x0204;
const RECORD_NUMBER = 0x0203;
const RECORD_BLANK = 0x0201;
const RECORD_BOF = 0x0809;
const RECORD_EOF = 0x000a;

export function parseBiff8Workbook(stream: Uint8Array): XlsSheet[] {
  const sheets: XlsSheet[] = [];
  const cells = new Map<string, string | number | null>();
  let inSheet = false;

  let offset = 0;
  while (offset + 4 <= stream.length) {
    const type = readU16(stream, offset);
    const length = readU16(stream, offset + 2);
    const data = stream.subarray(offset + 4, offset + 4 + length);
    if (type === RECORD_BOF) {
      inSheet = true;
      cells.clear();
    } else if (type === RECORD_EOF) {
      inSheet = false;
      const grid = toGrid(cells);
      if (grid) sheets.push(grid);
    } else if (inSheet && type === RECORD_LABEL) {
      const row = readU16(data, 0);
      const column = readU16(data, 2);
      const charCount = readU16(data, 6);
      const flags = data[8] ?? 0;
      const wide = (flags & 0x01) !== 0;
      const hasRichText = (flags & 0x08) !== 0;
      const hasExtended = (flags & 0x04) !== 0;
      let cursor = 9 + (hasRichText ? 2 : 0) + (hasExtended ? 4 : 0);
      const value = wide
        ? utf16le(data.subarray(cursor, cursor + charCount * 2))
        : decodeLatin1(data.subarray(cursor, cursor + charCount));
      cells.set(`${row}:${column}`, value);
    } else if (inSheet && type === RECORD_NUMBER) {
      const row = readU16(data, 0);
      const column = readU16(data, 2);
      const value = readDouble(data, 6);
      cells.set(`${row}:${column}`, Number.isInteger(value) ? value : Math.round(value * 100) / 100);
    } else if (inSheet && type === RECORD_BLANK) {
      const row = readU16(data, 0);
      const column = readU16(data, 2);
      cells.set(`${row}:${column}`, null);
    }
    offset += 4 + length;
  }
  return sheets;
}

function readDouble(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return view.getFloat64(0, true);
}

function decodeLatin1(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}

function toGrid(cells: Map<string, string | number | null>): XlsSheet | undefined {
  if (!cells.size) return undefined;
  let maxRow = -1;
  let maxColumn = -1;
  for (const key of cells.keys()) {
    const [rowText, columnText] = key.split(":");
    const row = Number(rowText);
    const column = Number(columnText);
    if (row > maxRow) maxRow = row;
    if (column > maxColumn) maxColumn = column;
  }
  const rows: (string | number | null)[][] = [];
  for (let row = 0; row <= maxRow; row += 1) {
    const values: (string | number | null)[] = [];
    for (let column = 0; column <= maxColumn; column += 1) {
      const value = cells.get(`${row}:${column}`);
      values.push(value === undefined ? null : value);
    }
    rows.push(values);
  }
  const nonEmpty = rows.filter((row) => row.some((value) => value !== null));
  const titleRowIndex = nonEmpty.findIndex((row) => {
    const present = row.filter((value) => value !== null);
    return present.length === 1 && typeof present[0] === "string";
  });
  const title = titleRowIndex >= 0 ? (nonEmpty[titleRowIndex]!.find((value) => typeof value === "string") as string) : undefined;
  return { title, columns: [], rows: nonEmpty };
}

// Extract the date range quoted in a WeChat report title such as
// "全部群发详细数据-日报（2025-10-01至2025-11-01）".
export function extractReportRange(title: string | undefined): { begin: string; end: string } | undefined {
  if (!title) return undefined;
  const match = title.match(/（(\d{4}-\d{2}-\d{2})至(\d{4}-\d{2}-\d{2})）/);
  if (!match?.[1] || !match[2]) return undefined;
  return { begin: match[1], end: match[2] };
}

export function parseXlsReport(buffer: ArrayBuffer): XlsSheet | undefined {
  const bytes = new Uint8Array(buffer);
  if (!isOle2(bytes)) {
    throw new WechatMcpError("INVALID_RESPONSE", "The response is not an OLE2 (.xls) file.");
  }
  const workbook = parseOle2Streams(bytes).get("Workbook");
  if (!workbook) {
    throw new WechatMcpError("INVALID_RESPONSE", "The .xls file contains no Workbook stream.");
  }
  const sheets = parseBiff8Workbook(workbook);
  return sheets.find((sheet) => sheet.rows.length > 0);
}
