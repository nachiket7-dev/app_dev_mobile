import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useAppTheme, useThemedStyles } from '../context/ThemeContext';
import { SERVER_PRESETS } from '../utils/server';

export default function ServerOptions({ url, onChangeUrl, mode, onChangeMode, disabled = false, allowLocalHttp = false }) {
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  return <View style={styles.section}>
    <Text style={styles.label}>Backend Mode</Text>
    <View style={styles.row} accessibilityRole="radiogroup">
      {[['included', 'Included backend'], ['legacy', 'External / campus legacy']].map(([value, label]) =>
        <TouchableOpacity key={value} style={[styles.chip, mode === value && styles.selected]} disabled={disabled}
          onPress={() => onChangeMode(value)} accessibilityRole="radio" accessibilityState={{ checked: mode === value, disabled }}>
          <Text style={[styles.chipText, mode === value && { color: colors.primary }]}>{label}</Text>
        </TouchableOpacity>
      )}
    </View>
    <Text style={styles.note}>{mode === 'included'
      ? 'Checks public health before sign-in. New send IDs and receipts are enabled only when the server advertises support.'
      : 'Uses the original course API and inline photos. No new endpoints, duplicate-send protection, or read receipts are assumed.'}</Text>
    {allowLocalHttp && <>
      <Text style={styles.label}>Local Development Presets</Text>
      <View style={styles.row}>
        {SERVER_PRESETS.map((preset) => <TouchableOpacity key={preset.url} style={[styles.chip, url === preset.url && styles.selected]}
          disabled={disabled} onPress={() => onChangeUrl(preset.url)} accessibilityRole="button">
          <Text style={[styles.chipText, url === preset.url && { color: colors.primary }]}>{preset.label}</Text>
        </TouchableOpacity>)}
      </View>
    </>}
    <Text style={styles.note}>Enter the full URL. On a phone, use your computer&apos;s LAN IP or .local hostname, not localhost. Shared builds require HTTPS.</Text>
  </View>;
}

const createStyles = (colors) => StyleSheet.create({
  section: { marginVertical: 12, paddingHorizontal: 4 },
  label: { fontSize: 12, fontWeight: '600', color: colors.secondaryText, marginBottom: 8, textTransform: 'uppercase' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: colors.input, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: 'transparent' },
  selected: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text, fontWeight: '500' },
  note: { fontSize: 12, lineHeight: 17, color: colors.secondaryText, marginTop: 8, marginBottom: 12 },
});
