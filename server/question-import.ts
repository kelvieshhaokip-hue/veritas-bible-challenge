import { inflateRawSync } from 'node:zlib';

export type ImportedQuestionRow = { rowNumber: number; cells: string[] };

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 100;
const MAX_IMPORT_ROWS = 1000;

function decodeBase64(encoded: string) {
  if (encoded.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Upload must be a valid file smaller than 5 MB.');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new Error('Upload must be a non-empty file smaller than 5 MB.');
  return bytes;
}

function parseCsv(source: string): ImportedQuestionRow[] {
  const text = source.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell.length === 0) quoted = true;
    else if (character === ',') { row.push(cell); cell = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += character;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const nonempty = rows.map((cells, index) => ({ rowNumber: index + 1, cells })).filter(entry => entry.cells.some(value => value.trim()));
  if (nonempty.length > MAX_IMPORT_ROWS + 1) throw new Error(`Import is limited to ${MAX_IMPORT_ROWS} question rows.`);
  return nonempty;
}

function xmlDecode(value: string) {
  return value.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_match, number: string) => {
    const code = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : parseInt(number, 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function attribute(attributes: string, key: string) {
  return attributes.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1];
}

function zipFiles(bytes: Buffer) {
  const searchStart = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset--) if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  if (eocd < 0) throw new Error('Excel workbook is not a valid .xlsx file.');
  const entries = bytes.readUInt16LE(eocd + 10), directorySize = bytes.readUInt32LE(eocd + 12), directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (entries > MAX_ZIP_ENTRIES || directoryOffset + directorySize > bytes.length) throw new Error('Excel workbook has an invalid or oversized file directory.');
  const files = new Map<string, Buffer>();
  let offset = directoryOffset, totalUncompressed = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Excel workbook contains an invalid file entry.');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), compressedSize = bytes.readUInt32LE(offset + 20), uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32), localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name || name.endsWith('/')) continue;
    if ((flags & 1) || ![0, 8].includes(method) || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error('Excel workbook uses an unsupported or encrypted file entry.');
    totalUncompressed += uncompressedSize;
    if (uncompressedSize > MAX_UNCOMPRESSED_BYTES || totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error('Excel workbook expands beyond the 16 MB safety limit.');
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Excel workbook contains an invalid file header.');
    const localNameLength = bytes.readUInt16LE(localOffset + 26), localExtraLength = bytes.readUInt16LE(localOffset + 28), dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.length) throw new Error('Excel workbook file entry is truncated.');
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    const content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
    if (content.length !== uncompressedSize) throw new Error('Excel workbook file entry has an invalid size.');
    files.set(name, content);
  }
  return files;
}

function parseXlsx(bytes: Buffer): ImportedQuestionRow[] {
  const files = zipFiles(bytes);
  const workbook = files.get('xl/workbook.xml')?.toString('utf8');
  const relationships = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (!workbook || !relationships) throw new Error('Excel workbook is missing its workbook metadata.');
  const sheetAttributes = workbook.match(/<sheet\b([^>]*)\/?\s*>/i)?.[1];
  const relationshipId = sheetAttributes && attribute(sheetAttributes, 'r:id');
  if (!relationshipId) throw new Error('Excel workbook has no readable worksheet.');
  const relationship = [...relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)].map(match => match[1]).find(attrs => attribute(attrs, 'Id') === relationshipId);
  const target = relationship && attribute(relationship, 'Target');
  if (!target) throw new Error('Excel workbook worksheet reference is invalid.');
  const sheetPath = target.startsWith('/') ? target.slice(1) : target.startsWith('xl/') ? target : `xl/${target}`;
  const sheet = files.get(sheetPath)?.toString('utf8');
  if (!sheet) throw new Error('Excel workbook worksheet could not be read.');
  const sharedStrings = (files.get('xl/sharedStrings.xml')?.toString('utf8').match(/<si\b[^>]*>([\s\S]*?)<\/si>/gi) || []).map(item =>
    [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(match => xmlDecode(match[1])).join(''));
  const rows: ImportedQuestionRow[] = [];
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
    const rowNumber = Number(attribute(rowMatch[1], 'r')) || rows.length + 1;
    const cells: string[] = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const reference = attribute(cellMatch[1], 'r') || '';
      const columnLetters = reference.match(/^[A-Z]+/i)?.[0] || '';
      let column = 0;
      for (const letter of columnLetters.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
      if (!column) continue;
      const type = attribute(cellMatch[1], 't');
      const value = type === 'inlineStr'
        ? [...cellMatch[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(match => xmlDecode(match[1])).join('')
        : xmlDecode(cellMatch[2].match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] || '');
      cells[column - 1] = type === 's' ? sharedStrings[Number(value)] || '' : value;
    }
    rows.push({ rowNumber, cells });
  }
  const nonempty = rows.filter(entry => entry.cells.some(value => value?.trim()));
  if (nonempty.length > MAX_IMPORT_ROWS + 1) throw new Error(`Import is limited to ${MAX_IMPORT_ROWS} question rows.`);
  return nonempty;
}

export function parseQuestionImport(filename: string, encoded: string) {
  const bytes = decodeBase64(encoded);
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) return parseCsv(bytes.toString('utf8'));
  if (lower.endsWith('.xlsx')) return parseXlsx(bytes);
  throw new Error('Choose a CSV or Excel .xlsx file.');
}
