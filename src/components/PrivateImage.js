import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Platform, Text, TouchableOpacity, View } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { useAppTheme } from '../context/ThemeContext';
import { apiFetch, getAuthHeader } from '../api/config';
import { resolveMessageImage } from '../utils/privateMedia';
import { sessionMediaReadQueue, waitForMediaRetry } from '../utils/mediaReadQueue';

export default function PrivateImage({ message, style, resizeMode = 'cover', enabled = true }) {
  const { sessionKey, sessionConfig } = useAuth();
  const { colors } = useAppTheme();
  const [reload, setReload] = useState(0);
  const onReload = useCallback(() => setReload((value) => value + 1), []);
  const image = resolveMessageImage(message, sessionConfig.baseUrl);
  if (!enabled) return <View style={[style, { alignItems: 'center', justifyContent: 'center' }]}><ActivityIndicator color={colors.primary} /></View>;
  // A mounted image owns one request/blob lease. Offscreen or changed sources destroy it.
  return <ImageContent key={`${sessionKey}:${image?.uri}:${reload}`} image={image} config={sessionConfig}
    style={style} resizeMode={resizeMode} reload={reload} onReload={onReload} />;
}

function ImageContent({ image, config, style, resizeMode, reload, onReload }) {
  const { colors } = useAppTheme();
  const [objectUrl, setObjectUrl] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [nativeReady, setNativeReady] = useState(false);
  const [nativeCallbacks, setNativeCallbacks] = useState(null);
  const uri = image?.uri;
  const authenticated = !!image?.authenticated;
  const authHeader = getAuthHeader(config);

  useEffect(() => {
    if (!uri || !authenticated || !authHeader) return;
    const controller = new AbortController();
    let leasedUrl;
    let releasePermit;
    let retryTimer;
    let mounted = true;
    const release = () => {
      controller.abort();
      if (Platform.OS !== 'web') { releasePermit?.(); releasePermit = undefined; }
      clearTimeout(retryTimer);
      if (leasedUrl) URL.revokeObjectURL(leasedUrl);
      leasedUrl = undefined;
    };
    const sessionEnded = () => {
      release();
      if (mounted) { setObjectUrl(null); setNativeReady(false); }
    };
    config.signal?.addEventListener('abort', sessionEnded, { once: true });
    const current = () => mounted && !controller.signal.aborted && !config.signal?.aborted;
    const queue = sessionMediaReadQueue(config);
    if (Platform.OS === 'web') {
      const read = async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          releasePermit = await queue.acquire([config.signal, controller.signal]);
          try {
            return await apiFetch(uri.slice(config.baseUrl.length), {
              config, signal: controller.signal, responseType: 'image', timeoutMs: 15000,
            });
          } catch (error) {
            if (error.status !== 429 || attempt === 2) throw error;
          } finally { releasePermit?.(); releasePermit = undefined; }
          await waitForMediaRetry(1000, [config.signal, controller.signal]);
        }
      };
      void read().then((blob) => {
        if (!current()) return;
        leasedUrl = URL.createObjectURL(blob);
        setObjectUrl(leasedUrl);
      }).catch((error) => { if (current()) setLoadError(error.message || 'Photo unavailable.'); });
    } else {
      void queue.acquire([config.signal, controller.signal]).then((permit) => {
        if (!current()) { permit(); return; }
        releasePermit = permit;
        const complete = () => { releasePermit?.(); releasePermit = undefined; };
        setNativeCallbacks({
          complete,
          fail: (event) => {
            complete();
            if (!current()) return;
            if (/\b429\b/.test(event?.nativeEvent?.error || '') && reload < 2) {
              setNativeReady(false);
              retryTimer = setTimeout(() => { if (current()) onReload(); }, 1000);
            } else setLoadError('Could not display this photo. Try reloading it.');
          },
        });
        setNativeReady(true);
      }).catch((error) => { if (current()) setLoadError(error.message || 'Photo unavailable.'); });
    }
    return () => {
      mounted = false;
      release();
      config.signal?.removeEventListener('abort', sessionEnded);
    };
  }, [authenticated, authHeader, config, uri, reload, onReload]);

  const error = !image ? 'Photo unavailable or unsupported.' : authenticated && !authHeader ? 'Sign in to view this photo.' : loadError;
  if (error) return <View style={[style, { alignItems: 'center', justifyContent: 'center', padding: 12, gap: 8 }]} accessibilityRole="alert">
    <Text style={{ fontSize: 13, lineHeight: 18, textAlign: 'center', color: colors.secondaryText }}>{error}</Text>
    {image && <TouchableOpacity onPress={onReload} accessibilityRole="button"><Text style={{ color: colors.primary, fontSize: 13 }}>Reload Photo</Text></TouchableOpacity>}
  </View>;
  if (authenticated && (Platform.OS === 'web' ? !objectUrl : !nativeReady)) {
    return <View style={[style, { alignItems: 'center', justifyContent: 'center' }]}><ActivityIndicator color={colors.primary} accessibilityLabel="Loading protected photo" /></View>;
  }
  const nativeUri = authenticated ? `${uri}${uri.includes('?') ? '&' : '?'}session=${encodeURIComponent(config.sessionKey || '')}&reload=${reload}` : uri;
  const source = Platform.OS === 'web' ? { uri: authenticated ? objectUrl : uri }
    : { uri: nativeUri, headers: authenticated ? { Authorization: authHeader, 'Cache-Control': 'no-store' } : undefined, cache: 'reload' };
  return <Image source={source} style={style} resizeMode={resizeMode} resizeMethod="resize" accessibilityLabel="Message photo"
    onLoadEnd={nativeCallbacks?.complete}
    onError={nativeCallbacks?.fail || (() => setLoadError('Could not display this photo. Try reloading it.'))} />;
}
