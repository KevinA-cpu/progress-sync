import {
  MAX_DIAGRAM_BYTES, MAX_DIAGRAM_HEIGHT, MAX_DIAGRAM_PIXELS, MAX_DIAGRAM_WIDTH,
} from './constants/report';
import { SOURCE_HASH_ALGORITHM } from './constants/progress';
import { problemIdSchema } from './progress';
import { attributionUrl } from './report';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Only the chunks a canvas produces for a static image. Text, animation, and private chunks are refused, so no
// extra payload can ride along inside a stored image.
const PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'bKGD', 'iCCP']);
// The bit depths each colour type is defined for. A combination outside this is not an image any browser will
// decode, so it is refused rather than stored and later shown as a broken picture.
const PNG_BIT_DEPTHS = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);

export function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) {
    crc = (CRC_TABLE[(crc ^ (bytes[index] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Reads the image as a byte structure rather than trusting what produced it: signature, every chunk length and
// checksum, an allowed chunk set, the dimensions and the pixel format the header itself states, and the chunk
// order a decoder requires. An image with no pixel data, a bit depth its colour type does not define, a palette
// that arrives too late or is missing where it is required, or data split around another chunk is refused here,
// so nothing that a browser would fail to draw is ever stored, published, or shown as a recovered diagram.
export function readPng(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < PNG_SIGNATURE.length + 12 || bytes.length > MAX_DIAGRAM_BYTES) return null;
  if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let header: { width: number; height: number } | null = null;
  let colorType: number | null = null;
  let palette = false;
  let data = 0;
  let dataBytes = 0;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    if (ended) return null;
    const length = view.getUint32(offset);
    if (length > bytes.length || offset + 12 + length > bytes.length) return null;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!PNG_CHUNKS.has(type)) return null;
    if (view.getUint32(offset + 8 + length) !== crc32(bytes, offset + 4, offset + 8 + length)) return null;
    if (type === 'IHDR') {
      if (header !== null || length !== 13 || offset !== PNG_SIGNATURE.length) return null;
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      const depth = bytes[offset + 16];
      const declared = bytes[offset + 17];
      const depths = declared === undefined ? undefined : PNG_BIT_DEPTHS.get(declared);
      if (width < 1 || height < 1 || width > MAX_DIAGRAM_WIDTH || height > MAX_DIAGRAM_HEIGHT
        || width * height > MAX_DIAGRAM_PIXELS || depth === undefined || depths === undefined
        || !depths.includes(depth)
        || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || (bytes[offset + 20] ?? 2) > 1) return null;
      header = { width, height };
      colorType = declared ?? null;
    } else if (header === null || colorType === null) {
      return null;
    } else if (type === 'PLTE') {
      if (palette || data > 0 || colorType === 0 || colorType === 4) return null;
      if (length === 0 || length % 3 !== 0 || length > 256 * 3) return null;
      palette = true;
    } else if (type === 'IDAT') {
      if (colorType === 3 && !palette) return null;
      data++;
      dataBytes += length;
    } else if (type === 'IEND') {
      if (length !== 0) return null;
      ended = true;
    } else if (data > 0) {
      // Image data is one unbroken run of chunks; anything between them makes the stream undecodable.
      return null;
    }
    offset += 12 + length;
  }
  return ended && data > 0 && dataBytes > 0 && offset === bytes.length ? header : null;
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(SOURCE_HASH_ALGORITHM, bytes as BufferSource);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// The public attribution link for a problem, from the one rule every boundary checks it against.
export function problemUrl(problemId: string): string | null {
  return problemIdSchema.safeParse(problemId).success ? attributionUrl(problemId) : null;
}
