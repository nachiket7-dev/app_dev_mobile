import { Prisma } from '@prisma/client';

export type Receipts = Record<string, { delivered: boolean; read: boolean }>;

export function receipts(value: Prisma.JsonValue): Receipts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Receipts = {};
  for (const [rawId, entry] of Object.entries(value)) {
    if (/^[0-9a-f]{24}$/i.test(rawId) && entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const id = rawId.toLowerCase();
      const read = entry.read === true || result[id]?.read === true;
      result[id] = { delivered: entry.delivered === true || result[id]?.delivered === true || read, read };
    }
  }
  return result;
}

export function unreadCounts(value: Prisma.JsonValue, participants: string[]) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(participants.map((id) => {
    const count = source[id];
    return [id, typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : 0];
  })) as Record<string, number>;
}

export function messagePreview(content: string | null, attachmentKind?: string | null, hasImage = false) {
  const text = content?.replace(/\s+/g, ' ').trim();
  if (text) return Array.from(text).slice(0, 160).join('');
  return attachmentKind === 'IMAGE' || hasImage ? '[Image]' : attachmentKind ? '[File]' : '';
}
