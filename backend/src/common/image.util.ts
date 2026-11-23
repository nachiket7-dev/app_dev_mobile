import { BadRequestException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
const sharp: typeof import('sharp') & typeof import('sharp').default = require('sharp');
import { decode as bmpDecode } from 'bmp-ts';
import { detectImageMime } from './base64.util';
import { CONFIG } from './config';

sharp.cache(false);
sharp.concurrency(1);
let active = 0;
const pending: Array<() => void> = [];

function validateBmp(buffer: Buffer) {
  if (buffer.length < 54) throw new BadRequestException('Truncated BMP image');
  const headerSize = buffer.readUInt32LE(14);
  const width = buffer.readInt32LE(18);
  const signedHeight = buffer.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const bits = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);
  const colors = buffer.readUInt32LE(46);
  const offset = buffer.readUInt32LE(10);
  if (!width || width < 0 || !height || width > 8192 || height > 8192 || width * height > CONFIG.maxImagePixels) {
    throw new PayloadTooLargeException('BMP dimensions exceed the decoded pixel limit');
  }
  // The decoder reads its palette before its own pixel allocation check, so bound both first.
  if (![40, 52, 56, 108, 124].includes(headerSize) || headerSize + 14 > buffer.length ||
      buffer.readUInt16LE(26) !== 1 || ![1, 4, 8, 16, 24, 32].includes(bits) || colors > 256 ||
      (bits <= 8 && colors > 2 ** bits) || ![0, 1, 2, 3, 6].includes(compression) ||
      (compression === 1 && bits !== 8) || (compression === 2 && bits !== 4) ||
      ((compression === 3 || compression === 6) && bits !== 16 && bits !== 32)) {
    throw new BadRequestException('Invalid BMP header, palette or compression');
  }
  const palette = bits <= 8 ? colors || 2 ** bits : colors;
  const extraMasks = headerSize === 40 ? (compression === 3 ? 12 : compression === 6 ? 16 : 0) :
    headerSize === 52 && compression === 6 ? 4 : 0;
  const pixelStart = 14 + headerSize + extraMasks + palette * 4;
  if (offset < pixelStart || offset > buffer.length || buffer.readUInt32LE(2) > buffer.length) {
    throw new BadRequestException('Truncated or invalid BMP data');
  }
  if (compression === 1 || compression === 2) {
    let position = offset;
    let x = 0;
    let y = 0;
    let ended = false;
    while (position + 2 <= buffer.length) {
      const run = buffer[position++];
      const code = buffer[position++];
      if (run) x += run;
      else if (code === 0) { x = 0; y++; }
      else if (code === 1) { ended = true; break; }
      else if (code === 2) {
        if (position + 2 > buffer.length) break;
        x += buffer[position++]; y += buffer[position++];
      } else {
        const bytes = compression === 2 ? Math.ceil(code / 2) : code;
        position += bytes + bytes % 2;
        x += code;
      }
      if (x > width || y > height || (y === height && x > 0) || position > buffer.length) throw new BadRequestException('Invalid BMP run-length data');
    }
    if (!ended || signedHeight < 0) throw new BadRequestException('Truncated BMP run-length data');
  } else if (offset + Math.ceil(width * bits / 32) * 4 * height > buffer.length) {
    throw new BadRequestException('Truncated BMP pixel data');
  }
  if (bits <= 8 && compression === 0) {
    const stride = Math.ceil(width * bits / 32) * 4;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const byte = buffer[offset + y * stride + Math.floor(x * bits / 8)];
      const color = bits === 8 ? byte : bits === 4 ? (x % 2 ? byte & 15 : byte >> 4) : (byte >> (7 - x % 8)) & 1;
      if (color >= palette) throw new BadRequestException('Invalid BMP palette index');
    }
  }
  // Respect legitimate gaps between the palette/header and the pixels without altering stored bytes.
  const input = offset === pixelStart ? buffer : Buffer.concat([buffer.subarray(0, pixelStart), buffer.subarray(offset)]);
  bmpDecode(input, { toRGBA: true, maxResolutionInMP: CONFIG.maxImagePixels / 1_000_000 });
}

/** Decode pixels, not just headers. Compressed pixel bombs and animation frames share one cap. */
export async function validateRasterImage(buffer: Buffer): Promise<string | null> {
  const mime = detectImageMime(buffer);
  if (!mime) return null;
  if (active >= 2) {
    if (pending.length >= 16) throw new ServiceUnavailableException('Image decoder is busy; retry later');
    await new Promise<void>((resolve) => pending.push(resolve));
  } else active++;
  try {
    if (mime === 'image/bmp') { validateBmp(buffer); return mime; }
    const image = sharp(buffer, { failOn: 'warning', limitInputPixels: CONFIG.maxImagePixels, limitInputChannels: 4, animated: true });
    const metadata = await image.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.pageHeight ?? metadata.height ?? 0;
    const pages = metadata.pages ?? 1;
    if (!width || !height || width > 8192 || height > 8192 || pages > 100 ||
        width * height * pages > CONFIG.maxImagePixels) {
      throw new PayloadTooLargeException('Image dimensions or total decoded pixels exceed the limit');
    }
    if (!['jpeg', 'png', 'gif', 'webp', 'heif', 'avif', 'bmp'].includes(metadata.format ?? '')) {
      throw new BadRequestException('Unsupported raster image format');
    }
    await image.timeout({ seconds: 5 }).raw().toBuffer();
    return mime;
  } catch (error) {
    if (error instanceof PayloadTooLargeException || error instanceof BadRequestException) throw error;
    throw new BadRequestException('Image is truncated, undecodable or unsupported; use PNG, JPEG, GIF, WebP, BMP or AVIF');
  } finally {
    const next = pending.shift();
    if (next) next(); else active--;
  }
}
