import { Stack, usePathname } from 'expo-router';
import AppProviders from '../../App';
import { useAuth } from '../context/AuthContext';
import { useAppTheme } from '../context/ThemeContext';
import { safeReturnPath } from '../utils/session';

export const unstable_settings = { anchor: '(tabs)' };

function RootNavigator() {
  const { isAuthenticated } = useAuth();
  const { colors } = useAppTheme();
  const pathname = usePathname();
  return <Stack screenOptions={{
    headerTintColor: colors.primary,
    headerStyle: { backgroundColor: colors.surface },
    headerTransparent: false,
    headerTitleAlign: 'center',
    contentStyle: { backgroundColor: colors.background },
    headerBackTitle: 'Messages',
  }}>
    <Stack.Screen name="index" options={{ headerShown: false }} />
    <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    <Stack.Protected guard={isAuthenticated} redirectTo={{ pathname: '/sign-in', params: { returnTo: safeReturnPath(pathname) } }}>
      <Stack.Screen name="new-chat" options={{ title: 'New Message', headerBackTitle: 'Cancel', headerShadowVisible: false }} />
      <Stack.Screen name="chat/[conversationId]" options={{ title: 'Conversation' }} />
    </Stack.Protected>
  </Stack>;
}

export default function RootLayout() {
  return <AppProviders><RootNavigator /></AppProviders>;
}
