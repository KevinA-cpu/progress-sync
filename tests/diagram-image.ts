import { deflateSync, inflateSync } from 'node:zlib';

// Images are checked as bytes here, not as labels: a captured chart is decoded back to pixels so a test can say
// what was actually drawn, and a published fixture image is built to the same byte structure the extension
// accepts. Nothing here is copied from the provider.
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

export type Colour = readonly [number, number, number];

// A solid image with exactly the chunks a stored diagram may hold: signature, IHDR, one IDAT, IEND.
export function buildPng(width: number, height: number, colour: Colour): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * (stride + 1) + 1 + x * 3;
      raw.writeUInt8(colour[0], at);
      raw.writeUInt8(colour[1], at + 1);
      raw.writeUInt8(colour[2], at + 2);
    }
  }
  return Buffer.concat([
    SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The same image with one compressed byte changed: the same length and path, bytes that are no longer the ones
// the report names.
export function corruptPng(bytes: Buffer): Buffer {
  const copy = Buffer.from(bytes);
  const at = copy.length - 20;
  copy.writeUInt8(copy.readUInt8(at) ^ 0xff, at);
  return copy;
}

export interface DecodedPng {
  width: number;
  height: number;
  rgb: Buffer;
}

function paeth(left: number, up: number, corner: number): number {
  const estimate = left + up - corner;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toCorner = Math.abs(estimate - corner);
  return toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
}

// Reads a stored image back to pixels, checking every chunk's checksum on the way, so a test asserts on what the
// image draws rather than on its size alone.
export function decodePng(bytes: Buffer): DecodedPng {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG image.');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (bytes.readUInt32BE(offset + 8 + length) !== crc32(bytes.subarray(offset + 4, offset + 8 + length))) {
      throw new Error(`PNG chunk ${type} failed its checksum.`);
    }
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const colourType = data.readUInt8(9);
      if (data.readUInt8(8) !== 8 || data.readUInt8(12) !== 0 || (colourType !== 2 && colourType !== 6)) {
        throw new Error('Unsupported PNG encoding.');
      }
      channels = colourType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      parts.push(Buffer.from(data));
    }
    offset += 12 + length;
  }
  if (width < 1 || height < 1 || channels === 0) throw new Error('PNG header missing.');
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const rgb = Buffer.alloc(width * height * 3);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw.readUInt8(start);
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? line.readUInt8(index - channels) : 0;
      const up = previous.readUInt8(index);
      const corner = index >= channels ? previous.readUInt8(index - channels) : 0;
      const delta = filter === 1 ? left
        : filter === 2 ? up
          : filter === 3 ? Math.floor((left + up) / 2)
            : filter === 4 ? paeth(left, up, corner) : 0;
      line.writeUInt8((line.readUInt8(index) + delta) & 0xff, index);
    }
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      rgb.writeUInt8(line.readUInt8(x * channels), at);
      rgb.writeUInt8(line.readUInt8(x * channels + 1), at + 1);
      rgb.writeUInt8(line.readUInt8(x * channels + 2), at + 2);
    }
    previous = line;
  }
  return { width, height, rgb };
}

export function countColour(image: DecodedPng, colour: Colour, tolerance = 32): number {
  let count = 0;
  for (let at = 0; at < image.rgb.length; at += 3) {
    if (Math.abs(image.rgb.readUInt8(at) - colour[0]) <= tolerance
      && Math.abs(image.rgb.readUInt8(at + 1) - colour[1]) <= tolerance
      && Math.abs(image.rgb.readUInt8(at + 2) - colour[2]) <= tolerance) count++;
  }
  return count;
}

export function countDrawn(image: DecodedPng): number {
  return image.width * image.height - countColour(image, [255, 255, 255], 8);
}
