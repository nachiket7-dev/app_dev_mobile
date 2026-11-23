import type { Message } from '../api/types';

export const PHOTO_BYTE_LIMIT = 10 * 1024 * 1024;
const RASTER_MIME = /^image\/(jpeg|png|gif|webp|bmp|avif|heic|heif)$/;

export function isImageMessage(message: Message & { localImageUri?: string }) {
  if (message.type === 'FILE' || message.file?.kind === 'FILE') return false;
  return message.type === 'IMAGE' || !!message.imageInfo || !message.type && message.file?.kind === 'IMAGE';
}

function base64Mime(data: string): string | null {
  if (data.startsWith('/9j/')) return 'image/jpeg';
  if (data.startsWith('iVBORw0KGgo')) return 'image/png';
  if (data.startsWith('R0lGOD')) return 'image/gif';
  if (data.startsWith('UklGR')) return 'image/webp';
  if (data.startsWith('Qk')) return 'image/bmp';
  return null;
}

function validInlineImage(uri: string) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
  return !!match && RASTER_MIME.test(match[1]) && match[2].length * 3 / 4 <= PHOTO_BYTE_LIMIT + 2;
}

export function resolveMessageImage(message: Message & { localImageUri?: string }, baseUrl: string): { uri: string; authenticated: boolean } | null {
  if (!isImageMessage(message)) return null;
  if (message.localImageUri) {
    if (/^(file|blob):/.test(message.localImageUri) || validInlineImage(message.localImageUri)) {
      return { uri: message.localImageUri, authenticated: false };
    }
  }
  const fileId = message.fileId || message.file?.id;
  if (fileId) return { uri: `${baseUrl}/file/${encodeURIComponent(fileId)}/download`, authenticated: true };
  const inline = message.imageInfo || '';
  if (validInlineImage(inline)) return { uri: inline, authenticated: false };
  const mimeType = base64Mime(inline);
  if (mimeType && validInlineImage(`data:${mimeType};base64,${inline}`)) {
    return { uri: `data:${mimeType};base64,${inline}`, authenticated: false };
  }
  try {
    const uri = inline.startsWith('/') ? `${baseUrl}${inline}` : inline;
    const url = new URL(uri);
    const base = new URL(baseUrl);
    if (url.origin === base.origin && uri.startsWith(`${baseUrl}/`) && !url.username && !url.password && !url.search && !url.hash) {
      return { uri, authenticated: true };
    }
  } catch {
    // Unsupported legacy image paths are shown as unavailable, never fetched anonymously.
  }
  return null;
}

interface PickedPhoto {
  base64?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  width?: number;
  height?: number;
}

export function preparePickedPhoto(asset: PickedPhoto) {
  const data = asset.base64;
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Unable to retrieve photo data. Your caption has been kept.');
  const size = data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (size > PHOTO_BYTE_LIMIT || (asset.width || 0) * (asset.height || 0) > 24_000_000) {
    throw new Error('Choose a smaller photo (up to 10 MB and 24 megapixels). Your caption has been kept.');
  }
  // SDK 58 can return JPEG bytes with the original PNG filename/MIME on iOS.
  const mimeType = base64Mime(data) || asset.mimeType || 'image/jpeg';
  if (!RASTER_MIME.test(mimeType)) throw new Error('Choose a supported photo, such as JPEG or PNG. Documents are not supported by this picker.');
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1];
  const fileName = asset.fileName?.trim().replace(/[\u0000-\u001f\/\\]/g, '_') || `photo.${extension}`;
  return { data: `data:${mimeType};base64,${data}`, mimeType, fileName };
}
