import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const outDir = new URL('../public/icons/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const palette = {
  green: [53, 93, 75, 255],
  cream: [247, 246, 241, 255],
  gold: [213, 162, 76, 255],
  page: [250, 249, 244, 255],
};
const polygons = [
  [[75, 255], [244, 280], [244, 421], [75, 389]],
  [[268, 280], [437, 255], [437, 389], [268, 421]],
];
const segments = [
  [[75, 255], [244, 280]], [[244, 280], [244, 421]], [[244, 421], [75, 389]], [[75, 389], [75, 255]],
  [[268, 280], [437, 255]], [[437, 255], [437, 389]], [[437, 389], [268, 421]], [[268, 421], [268, 280]],
  [[112, 315], [207, 330]], [[108, 346], [207, 361]], [[105, 377], [207, 393]],
  [[305, 330], [400, 315]], [[305, 361], [404, 346]], [[305, 393], [407, 377]],
  [[256, 278], [256, 423]],
];

function insidePolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function nearSegment(x, y, [[x1, y1], [x2, y2]], width) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= width / 2;
}
function colorAt(x, y) {
  if (x > 0 && x < 512 && y > 0 && y < 512) {
    if ((x >= 238 && x <= 274 && y >= 82 && y <= 268) || (x >= 188 && x <= 324 && y >= 132 && y <= 172)) return palette.cream;
    if ((x - 256) ** 2 + (y - 190) ** 2 <= 116 ** 2) return palette.gold;
    for (const polygon of polygons) if (insidePolygon(x, y, polygon)) {
      if (segments.slice(8).some(segment => nearSegment(x, y, segment, 5))) return palette.green;
      return palette.page;
    }
    if (segments.some((segment, index) => nearSegment(x, y, segment, index < 8 ? 7 : 5))) return palette.green;
  }
  return palette.green;
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function renderPng(size) {
  const samples = 3, scale = size / 512, rowBytes = size * 4 + 1, raw = Buffer.alloc(rowBytes * size);
  for (let py = 0; py < size; py++) {
    const row = py * rowBytes; raw[row] = 0;
    for (let px = 0; px < size; px++) {
      const sums = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
        const [r, g, b, a] = colorAt((px + (sx + 0.5) / samples) / scale, (py + (sy + 0.5) / samples) / scale);
        sums[0] += r; sums[1] += g; sums[2] += b; sums[3] += a;
      }
      const offset = row + 1 + px * 4;
      for (let channel = 0; channel < 4; channel++) raw[offset + channel] = Math.round(sums[channel] / (samples * samples));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [72, 96, 128, 144, 152, 180, 192, 384, 512]) {
  writeFileSync(new URL(`icon-${size}.png`, outDir), renderPng(size));
}
