import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

function current() {
  return AppState.currentState === 'active' &&
    (Platform.OS !== 'web' || typeof document !== 'undefined' && !document.hidden && document.hasFocus());
}

export function useAppActive() {
  const [active, setActive] = useState(current);
  useEffect(() => {
    const update = () => setActive(current());
    const change = AppState.addEventListener('change', update);
    const focus = Platform.OS === 'android' ? AppState.addEventListener('focus', update) : null;
    const blur = Platform.OS === 'android' ? AppState.addEventListener('blur', () => setActive(false)) : null;
    if (Platform.OS === 'web') {
      window.addEventListener('focus', update);
      window.addEventListener('blur', update);
      document.addEventListener('visibilitychange', update);
    }
    update();
    return () => {
      change.remove();
      focus?.remove();
      blur?.remove();
      if (Platform.OS === 'web') {
        window.removeEventListener('focus', update);
        window.removeEventListener('blur', update);
        document.removeEventListener('visibilitychange', update);
      }
    };
  }, []);
  return active;
}
