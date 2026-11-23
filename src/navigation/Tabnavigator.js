import React from 'react';
import { Platform } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';

export default function TabNavigator() {
  const { colors } = useAppTheme();
  const { isAuthenticated } = useAuth();
  const insets = useSafeAreaInsets();
  const bottom = Math.max(insets.bottom, 8);
  const messageOptions = {
    title: 'Messages',
    tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? 'chatbubble-ellipses' : 'chatbubble-ellipses-outline'} size={23} color={color} />,
  };
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.secondaryText,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.separator,
          borderTopWidth: 0.5,
          elevation: 8,
          height: Platform.OS === 'web' ? 'calc(60px + env(safe-area-inset-bottom, 0px))' : 52 + bottom,
          paddingBottom: Platform.OS === 'web' ? 'calc(8px + env(safe-area-inset-bottom, 0px))' : bottom,
          paddingTop: 6,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          letterSpacing: -0.2,
        },
      }}
    >
      <Tabs.Protected guard={!isAuthenticated} redirectTo="/chats">
        <Tabs.Screen name="sign-in" options={{ ...messageOptions, href: isAuthenticated ? null : '/sign-in' }} />
      </Tabs.Protected>
      <Tabs.Protected guard={isAuthenticated} redirectTo="/sign-in">
        <Tabs.Screen name="chats" options={{ ...messageOptions, href: isAuthenticated ? '/chats' : null }} />
      </Tabs.Protected>
      <Tabs.Screen
        name="settings"
        options={{ title: 'Settings', tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? 'settings' : 'settings-outline'} size={23} color={color} /> }}
      />
    </Tabs>
  );
}
