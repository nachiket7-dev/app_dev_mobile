import React, { useEffect, useMemo } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { DarkTheme, DefaultTheme, ThemeProvider as RouterThemeProvider } from 'expo-router/react-navigation';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './src/context/AuthContext';
import { ThemeProvider, useAppTheme } from './src/context/ThemeContext';
import { MessageOutboxProvider } from './src/context/MessageOutboxContext';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function AppContent({ children }) {
  const { colors, isDark } = useAppTheme();
  const navigationTheme = useMemo(() => {
    const baseTheme = isDark ? DarkTheme : DefaultTheme;
    return {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        primary: colors.primary,
        background: colors.background,
        card: colors.surface,
        text: colors.text,
        border: colors.separator,
        notification: colors.danger,
      },
    };
  }, [colors, isDark]);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background).catch(() => {});
  }, [colors.background]);

  return (
    <RouterThemeProvider value={navigationTheme}>
      {children}
      <StatusBar style={isDark ? 'light' : 'dark'} animated />
    </RouterThemeProvider>
  );
}

export default function AppProviders({ children }) {
  return (
    <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <MessageOutboxProvider>
              <AppContent>{children}</AppContent>
            </MessageOutboxProvider>
          </AuthProvider>
        </ThemeProvider>
    </QueryClientProvider>
  );
}
