import { BadRequestException } from '@nestjs/common';

export const MAX_CONTENT_LENGTH = 4000;
export const MAX_NAME_LENGTH = 100;
export const MAX_PARTICIPANTS = 100;
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;
const TEXT_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

export function normalizeObjectId(input: string) {
  if (typeof input !== 'string' || !/^[0-9a-f]{24}$/i.test(input)) {
    throw new BadRequestException('A valid MongoDB ObjectId is required');
  }
  return input.toLowerCase();
}

export function cleanName(input: string, max = MAX_NAME_LENGTH) {
  if (typeof input !== 'string' || !input.trim() || input.length > max ||
      Buffer.byteLength(input, 'utf8') > max * 4 || CONTROLS.test(input) || Buffer.from(input, 'utf8').toString('utf8') !== input) {
    throw new BadRequestException(`Name must be non-blank, control-free and at most ${max} characters`);
  }
  return input.trim();
}

export function cleanFileName(input: string) {
  const name = cleanName(input, 255);
  if (/[\\/]/.test(name) || name === '.' || name === '..') {
    throw new BadRequestException('file_name must be a filename, not a path');
  }
  return name;
}

export function cleanContent(input: string | undefined | null) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string' || input.length > MAX_CONTENT_LENGTH ||
      Buffer.byteLength(input, 'utf8') > MAX_CONTENT_LENGTH * 4 || TEXT_CONTROLS.test(input) || Buffer.from(input, 'utf8').toString('utf8') !== input) {
    throw new BadRequestException(`content must be non-blank and at most ${MAX_CONTENT_LENGTH} characters`);
  }
  return input.trim() ? input : null;
}

export const BOT_NAME = 'FactBot';
export function isReservedBotName(name: string) {
  return name.trim().normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').toLowerCase() === BOT_NAME.toLowerCase();
}

export function canonicalDmKey(ids: string[]) {
  const normalized = [...new Set(ids.map(normalizeObjectId))].sort();
  if (normalized.length !== 2) throw new BadRequestException('A DM requires exactly two distinct participants');
  return `dm:${normalized.join(':')}`;
}
