import { Redirect, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import ChatRoomScreen from '../../screens/ChatRoomScreen';

export default function ChatRoute() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { sessionKey } = useAuth();
  if (typeof conversationId !== 'string' || !conversationId) return <Redirect href="/chats" />;
  return <ChatRoomScreen key={`${sessionKey}:${conversationId}`} conversationId={conversationId} />;
}
