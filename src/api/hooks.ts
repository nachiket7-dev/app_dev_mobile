import { useRef } from 'react';
import { useQuery, useMutation, useQueryClient, type QueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useAppActive } from '../hooks/useAppActive';
import { userApi } from './userApi';
import { conversationApi } from './conversationApi';
import { messageApi } from './messageApi';
import { getApiConfig } from './config';
import type { ApiConfig, Conversation, CreateConversationPayload, CreateMessagePayload, Message, User } from './types';
import { emptyHistory, mergeMessagePage, mergeHistoryGap, type MessageHistory } from '../utils/messageHistory';

export const QUERY_KEYS = {
  users: (scope: string) => ['session', scope, 'users'] as const,
  userProfile: (scope: string, userId?: string) => ['session', scope, 'user', userId || 'me'] as const,
  conversations: (scope: string) => ['session', scope, 'conversations'] as const,
  messages: (scope: string, conversationId: string) => ['session', scope, 'messages', conversationId, 'latest'] as const,
  history: (scope: string, conversationId: string) => ['session', scope, 'history', conversationId] as const,
};

export const isCurrentSession = (config: ApiConfig) =>
  !config.signal?.aborted && getApiConfig().sessionKey === config.sessionKey;

export function recordSentMessage(queryClient: QueryClient, config: ApiConfig, message: Message) {
  if (!isCurrentSession(config)) return;
  const scope = config.sessionKey || '';
  queryClient.setQueryData<MessageHistory>(QUERY_KEYS.history(scope, message.conversationId), (history) =>
    mergeMessagePage(history, { data: [message], count: 1 }, 'sent')
  );
  void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.messages(scope, message.conversationId), exact: true });
  void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.conversations(scope), exact: true });
}

export function useUsers(options?: Partial<UseQueryOptions<User[], Error>>) {
  const { sessionKey, sessionConfig, isAuthenticated } = useAuth();
  return useQuery({
    ...options,
    queryKey: QUERY_KEYS.users(sessionKey),
    queryFn: ({ signal }) => userApi.getAllUsers({ config: sessionConfig, signal }),
    enabled: isAuthenticated && (options?.enabled ?? true),
  });
}

export function useCurrentUser(options?: Partial<UseQueryOptions<User, Error>>) {
  const { sessionKey, sessionConfig, isAuthenticated } = useAuth();
  return useQuery({
    staleTime: 60 * 1000,
    ...options,
    queryKey: QUERY_KEYS.userProfile(sessionKey),
    queryFn: ({ signal }) => userApi.getUserProfile(undefined, { config: sessionConfig, signal }),
    enabled: isAuthenticated && (options?.enabled ?? true),
  });
}

export function useUserProfile(userId?: string, options?: Partial<UseQueryOptions<User, Error>>) {
  const { sessionKey, sessionConfig, isAuthenticated } = useAuth();
  return useQuery({
    ...options,
    queryKey: QUERY_KEYS.userProfile(sessionKey, userId),
    queryFn: ({ signal }) => userApi.getUserProfile(userId, { config: sessionConfig, signal }),
    enabled: isAuthenticated && !!userId && (options?.enabled ?? true),
  });
}

export function useConversations(options?: { refetchInterval?: number | false; enabled?: boolean }) {
  const { sessionKey, sessionConfig, isAuthenticated } = useAuth();
  const active = useAppActive();
  return useQuery({
    queryKey: QUERY_KEYS.conversations(sessionKey),
    queryFn: ({ signal }) => conversationApi.getConversations({ config: sessionConfig, signal }),
    enabled: isAuthenticated && (options?.enabled ?? true),
    refetchInterval: active ? options?.refetchInterval ?? 5000 : false,
    refetchIntervalInBackground: false,
  });
}

export function useConversation(conversationId: string) {
  const query = useConversations({ refetchInterval: false });
  return { ...query, data: query.data?.find((conversation) => conversation.id === conversationId) };
}

export function useCreateConversation() {
  const { sessionKey, sessionConfig } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateConversationPayload) => conversationApi.createConversation(payload, { config: sessionConfig }),
    retry: false,
    onSuccess: (conversation) => {
      if (!isCurrentSession(sessionConfig)) return;
      queryClient.setQueryData<Conversation[]>(QUERY_KEYS.conversations(sessionKey), (previous = []) =>
        [conversation, ...previous.filter((item) => item.id !== conversation.id)]
      );
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.conversations(sessionKey), exact: true });
    },
  });
}

/** Latest-page polling is separate from the retained, cursor-loaded history. */
export function useMessages(conversationId: string, options?: { enabled?: boolean }) {
  const { sessionKey, sessionConfig, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const loadingOlder = useRef(false);
  const historyKey = QUERY_KEYS.history(sessionKey, conversationId);
  const history = useQuery({
    queryKey: historyKey,
    queryFn: emptyHistory,
    initialData: emptyHistory,
    enabled: false,
    gcTime: 30 * 60 * 1000,
  });
  const latest = useQuery({
    queryKey: QUERY_KEYS.messages(sessionKey, conversationId),
    queryFn: async ({ signal }) => {
      const page = await messageApi.getMessages({ conversation_id: conversationId }, { config: sessionConfig, signal });
      if (isCurrentSession(sessionConfig)) {
        queryClient.setQueryData<MessageHistory>(historyKey, (previous) => mergeMessagePage(previous, page));
      }
      // Normal polls fetch one page. A burst bridges at most three previously missing pages.
      for (let count = 0; count < 3 && isCurrentSession(sessionConfig); count++) {
        const cursor = queryClient.getQueryData<MessageHistory>(historyKey)?.gaps?.[0]?.cursor;
        if (!cursor || loadingOlder.current) break;
        const gap = await messageApi.getMessages({ conversation_id: conversationId, from_message_cursor: cursor }, { config: sessionConfig, signal });
        if (isCurrentSession(sessionConfig)) {
          queryClient.setQueryData<MessageHistory>(historyKey, (previous) => previous && mergeHistoryGap(previous, gap, cursor));
        }
      }
      return page;
    },
    enabled: isAuthenticated && !!conversationId && (options?.enabled ?? true),
    refetchInterval: options?.enabled === false ? false : 3000,
    refetchIntervalInBackground: false,
  });
  const older = useMutation({
    mutationFn: async ({ cursor, gap }: { cursor: string; gap: boolean }) => {
      const page = await messageApi.getMessages({ conversation_id: conversationId, from_message_cursor: cursor }, { config: sessionConfig });
      if (isCurrentSession(sessionConfig)) {
        queryClient.setQueryData<MessageHistory>(historyKey, (previous) => gap && previous
          ? mergeHistoryGap(previous, page, cursor) : mergeMessagePage(previous, page, 'older'));
      }
      return page.data.length;
    },
    retry: false,
  });
  const loadOlder = async () => {
    const retained = queryClient.getQueryData<MessageHistory>(historyKey);
    const gapCursor = retained?.gaps?.[0]?.cursor;
    const cursor = gapCursor || retained?.nextCursor;
    if (!cursor || loadingOlder.current || !isCurrentSession(sessionConfig)) return false;
    loadingOlder.current = true;
    try {
      return await older.mutateAsync({ cursor, gap: !!gapCursor }) > 0;
    } catch {
      return false;
    } finally {
      loadingOlder.current = false;
    }
  };
  return {
    data: history.data.data,
    nextCursor: history.data.gaps?.[0]?.cursor || history.data.nextCursor,
    isLoading: options?.enabled !== false && latest.isPending && !history.data.initialized,
    error: latest.error,
    refetch: latest.refetch,
    dataUpdatedAt: latest.dataUpdatedAt,
    loadOlder,
    isLoadingOlder: older.isPending,
    olderError: older.error,
  };
}

export function useSendMessage() {
  const { sessionConfig } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateMessagePayload) => messageApi.sendMessage(payload, { config: sessionConfig }),
    retry: false,
    onSuccess: (message) => recordSentMessage(queryClient, sessionConfig, message),
  });
}
