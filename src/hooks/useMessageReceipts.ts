import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { messageApi } from '../api/messageApi';
import { isCurrentSession, QUERY_KEYS } from '../api/hooks';
import type { Message } from '../api/types';
import { selectReceiptIds, type MessageHistory } from '../utils/messageHistory';

interface ReceiptLease {
  controller: AbortController;
  pending: Record<'read' | 'delivered', Set<string>>;
  busy: Record<'read' | 'delivered', boolean>;
}

export function useMessageReceipts(conversationId: string, messages: Message[], visibleIds: string[], active: boolean, retrievedAt: number) {
  const { user, sessionKey, sessionConfig, capabilities, backendMode } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [completedBatch, setCompletedBatch] = useState(0);
  const leaseRef = useRef<ReceiptLease | null>(null);
  const accountId = user?.id;

  useEffect(() => {
    if (!active || !accountId || backendMode !== 'included' || !capabilities.receipts) return;
    const lease: ReceiptLease = {
      controller: new AbortController(),
      pending: { delivered: new Set(), read: new Set() },
      busy: { delivered: false, read: false },
    };
    leaseRef.current = lease;
    return () => {
      lease.controller.abort();
      if (leaseRef.current === lease) leaseRef.current = null;
    };
  }, [active, accountId, backendMode, capabilities.receipts, conversationId, sessionKey]);

  useEffect(() => {
    const lease = leaseRef.current;
    if (!lease || !active || !accountId) return;
    const visible = new Set(visibleIds);
    for (const status of ['read', 'delivered'] as const) {
      if (lease.busy[status]) continue;
      const excluded = new Set([...lease.pending[status], ...(status === 'delivered' ? lease.pending.read : [])]);
      const ids = selectReceiptIds(messages, accountId, status, active, visible, excluded);
      if (!ids.length) continue;
      ids.forEach((id) => lease.pending[status].add(id));
      lease.busy[status] = true;
      let confirmed = false;
      const current = () => leaseRef.current === lease && !lease.controller.signal.aborted && isCurrentSession(sessionConfig);
      void messageApi.acknowledge({ conversation_id: conversationId, message_ids: ids, status }, { config: sessionConfig, signal: lease.controller.signal })
        .then(() => {
          if (!current()) return;
          confirmed = true;
          setError(null);
          const updated = new Set(ids);
          queryClient.setQueryData<MessageHistory>(QUERY_KEYS.history(sessionKey, conversationId), (history) => history && ({
            ...history,
            data: history.data.map((message) => !updated.has(message.id) ? message : {
              ...message, status: { ...message.status, [accountId]: {
                delivered: true, read: status === 'read' || !!message.status[accountId]?.read,
              } },
            }),
          }));
          void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.conversations(sessionKey), exact: true });
        }).catch((failure) => {
          if (current()) setError(failure instanceof Error ? failure.message : 'Could not update message receipts.');
        }).finally(() => {
          ids.forEach((id) => lease.pending[status].delete(id));
          lease.busy[status] = false;
          if (confirmed && current()) setCompletedBatch((value) => value + 1);
        });
    }
  }, [active, accountId, backendMode, capabilities.receipts, completedBatch, conversationId, messages, queryClient, retrievedAt, sessionConfig, sessionKey, visibleIds]);

  return error;
}
