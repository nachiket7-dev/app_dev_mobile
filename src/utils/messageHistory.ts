import type { Conversation, Message, PaginatedMessagesResponse } from '../api/types';

export interface MessageHistory {
  data: Message[];
  nextCursor: string | null;
  initialized: boolean;
  gaps?: { cursor: string; untilId: string }[];
}

export const emptyHistory = (): MessageHistory => ({ data: [], nextCursor: null, initialized: false });

export function compareMessages(a: Message, b: Message) {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);
}

/** Poll only the newest page; the older cursor belongs to the oldest loaded page. */
export function mergeMessagePage(
  history: MessageHistory = emptyHistory(),
  page: PaginatedMessagesResponse,
  kind: 'latest' | 'older' | 'sent' = 'latest'
): MessageHistory {
  const byId = new Map(history.data.map((message) => [message.id, message]));
  const gaps = [...(history.gaps || [])];
  const newestRetained = history.data.at(-1);
  if (kind === 'latest' && history.initialized && newestRetained && page.nextCursor &&
      page.data.length && page.data.every((message) => !byId.has(message.id)) &&
      page.data.every((message) => compareMessages(message, newestRetained) > 0)) {
    // More than one page arrived between polls. Retain the old cursor and bridge only the gap.
    gaps.push({ cursor: page.nextCursor, untilId: newestRetained.id });
  }
  for (const message of page.data) {
    const previous = byId.get(message.id);
    const status = { ...previous?.status, ...message.status };
    // Receipt updates are monotonic, including overlapping fetch/ack responses.
    for (const [id, receipt] of Object.entries(previous?.status || {})) {
      status[id] = {
        delivered: receipt.delivered || !!status[id]?.delivered,
        read: receipt.read || !!status[id]?.read,
      };
    }
    byId.set(message.id, { ...previous, ...message, status });
  }
  return {
    ...history,
    data: [...byId.values()].sort(compareMessages),
    nextCursor: kind === 'older' || !history.initialized && kind === 'latest'
      ? page.nextCursor || null : history.nextCursor,
    initialized: history.initialized || kind !== 'sent',
    gaps,
  };
}

export function mergeHistoryGap(history: MessageHistory, page: PaginatedMessagesResponse, cursor: string): MessageHistory {
  const gap = history.gaps?.find((item) => item.cursor === cursor);
  const merged = mergeMessagePage(history, page, 'sent');
  if (!gap) return merged;
  const boundary = history.data.find((message) => message.id === gap.untilId);
  const complete = !page.nextCursor || !page.data.length || page.nextCursor === cursor ||
    page.data.some((message) => message.id === gap.untilId || boundary && compareMessages(message, boundary) <= 0);
  return {
    ...merged,
    gaps: history.gaps?.flatMap((item) => item !== gap ? [item] : complete ? [] : [{ ...item, cursor: page.nextCursor! }]),
  };
}

export function conversationTitle(conversation: Conversation, accountId: string, names: Map<string, string>) {
  if (conversation.type === 'DM') {
    const otherId = conversation.participants_ids.find((id) => id !== accountId);
    return otherId ? names.get(otherId) || `User (${otherId.slice(-4)})` : 'Direct Message';
  }
  return conversation.name || 'Group Conversation';
}

export function selectReceiptIds(
  messages: Message[],
  accountId: string,
  status: 'delivered' | 'read',
  active: boolean,
  visibleIds: ReadonlySet<string>,
  alreadyAcknowledged: ReadonlySet<string> = new Set()
): string[] {
  if (!active) return [];
  return [...new Set(messages.filter((message) =>
    message.senderId !== accountId && !message.status[accountId]?.[status] &&
    !alreadyAcknowledged.has(message.id) && (status !== 'read' || visibleIds.has(message.id))
  ).map((message) => message.id))].slice(0, 100);
}
