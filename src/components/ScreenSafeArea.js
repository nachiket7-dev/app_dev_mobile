import React from 'react';
import { Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/** Router 58 uses CSS safe areas on web, and native insets on devices. */
export default function ScreenSafeArea({ edges = ['top', 'right', 'bottom', 'left'], style, ...props }) {
  if (Platform.OS !== 'web') return <SafeAreaView {...props} edges={edges} style={style} />;
  const spacing = {};
  for (const edge of edges) spacing[`padding${edge[0].toUpperCase()}${edge.slice(1)}`] = `env(safe-area-inset-${edge}, 0px)`;
  return <View {...props} style={[style, spacing]} />;
}
