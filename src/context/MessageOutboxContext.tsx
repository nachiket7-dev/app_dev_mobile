import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type PropsWithChildren } from 'react';
import { randomUUID } from 'expo-crypto';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './AuthContext';
import { fileApi } from '../api/fileApi';
import { messageApi } from '../api/messageApi';
import { isCurrentSession, recordSentMessage } from '../api/hooks';
import { createMessageOutbox } from '../utils/messageOutbox';

type OutboxStore = ReturnType<typeof createMessageOutbox>;
const MessageOutboxContext = createContext<OutboxStore | null>(null);

export function MessageOutboxProvider({ children }: PropsWithChildren) {
  const { user, sessionConfig, capabilities, backendMode } = useAuth();
  const queryClient = useQueryClient();
  const store = useMemo(() => createMessageOutbox({
    senderId: user?.id || '',
    sendMessage: (payload) => messageApi.sendMessage(payload, { config: sessionConfig }),
    uploadFile: (payload) => {
      if (backendMode === 'legacy') return Promise.reject(new Error('Legacy mode uses inline photos. Reselect this photo to send it.'));
      return fileApi.uploadFile(payload, { config: sessionConfig });
    },
    isCurrent: () => isCurrentSession(sessionConfig),
    createClientMessageId: backendMode === 'included' && capabilities.idempotency ? () => {
      try { return randomUUID(); }
      catch { throw new Error('Could not create a secure send ID. Open the web app on HTTPS or localhost, then try again. Your draft has been kept.'); }
    } : undefined,
    idempotency: backendMode === 'included' && capabilities.idempotency,
    onSent: (message) => recordSentMessage(queryClient, sessionConfig, message),
  }), [user?.id, sessionConfig, capabilities.idempotency, backendMode, queryClient]);

  useEffect(() => {
    store.setActive(true);
    return () => store.setActive(false);
  }, [store]);
  return <MessageOutboxContext.Provider value={store}>{children}</MessageOutboxContext.Provider>;
}

export function useMessageOutbox(conversationId?: string) {
  const store = useContext(MessageOutboxContext);
  if (!store) throw new Error('useMessageOutbox must be used within MessageOutboxProvider');
  const messages = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const outgoingMessages = useMemo(() => conversationId
    ? messages.filter((message) => message.conversationId === conversationId) : messages, [messages, conversationId]);
  return {
    ...store, outgoingMessages,
    unsentCount: messages.filter((message) => message.localStatus !== 'sent').length,
    isSending: !!conversationId && store.isSending(conversationId),
  };
}
