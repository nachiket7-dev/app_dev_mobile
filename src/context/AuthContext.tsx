import React, { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_BASE_URL, getApiConfig, setApiConfig, abortError } from '../api/config';
import { userApi } from '../api/userApi';
import { getServerCapabilities, LEGACY_CAPABILITIES } from '../api/serverApi';
import type { ApiConfig, BackendCapabilities, BackendMode, User } from '../api/types';
import { createSessionGuard, sessionKey } from '../utils/session';
import { isLocalHost, normalizeServerUrl } from '../utils/server';

const SERVER_STORAGE_KEY = '@chat-app/server-url';
const initialUrl = !process.env.EXPO_PUBLIC_API_URL && Platform.OS === 'android' ? 'http://10.0.2.2:3000' : DEFAULT_BASE_URL;
const allowLocalHttp = __DEV__ || Platform.OS === 'web' && typeof window !== 'undefined' &&
  ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

interface AuthValue {
  username: string;
  baseUrl: string;
  backendMode: BackendMode;
  user: User | null;
  capabilities: BackendCapabilities;
  sessionKey: string;
  sessionConfig: ApiConfig;
  isAuthenticated: boolean;
  isLoading: boolean;
  isRestoringServer: boolean;
  error: string | null;
  serverStorageError: string | null;
  allowLocalHttp: boolean;
  login: (username: string, password: string, url?: string, mode?: BackendMode) => Promise<User>;
  logout: () => void;
  setServerUrl: (url: string, mode?: BackendMode) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const guard = useRef(createSessionGuard());
  const hasChosenServer = useRef(false);
  const writes = useRef(Promise.resolve());
  const storageGeneration = useRef(0);
  const providerMounted = useRef(true);
  const [runId] = useState(() => Date.now().toString(36));
  const [baseUrl, setBaseUrl] = useState(initialUrl);
  const [backendMode, setBackendMode] = useState<BackendMode>('included');
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState('');
  const [capabilities, setCapabilities] = useState(LEGACY_CAPABILITIES);
  const [key, setKey] = useState('signed-out');
  const [isLoading, setIsLoading] = useState(false);
  const [isRestoringServer, setIsRestoringServer] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [serverStorageError, setServerStorageError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    providerMounted.current = true;
    const sessionGuard = guard.current;
    setApiConfig({ baseUrl: initialUrl, username: '', password: '', sessionKey: 'signed-out' });
    AsyncStorage.getItem(SERVER_STORAGE_KEY).then((saved) => {
      if (!mounted || hasChosenServer.current || !saved) return;
      // A formerly local URL remains selected, but release sign-in still requires HTTPS.
      const selected = normalizeServerUrl(saved, isLocalHost(new URL(saved).hostname));
      setBaseUrl(selected);
      setApiConfig({ baseUrl: selected, username: '', password: '' });
    }).catch(() => {
      if (mounted) setServerStorageError('Could not load the saved server URL.');
    }).finally(() => {
      if (mounted) setIsRestoringServer(false);
    });
    return () => {
      mounted = false;
      providerMounted.current = false;
      sessionGuard.invalidate();
      setApiConfig({ username: '', password: '', sessionKey: 'closed' });
    };
  }, []);

  const persistUrl = (url: string) => {
    const generation = ++storageGeneration.current;
    hasChosenServer.current = true;
    setServerStorageError(null);
    // This is the only saved session setting; never persist account credentials.
    writes.current = writes.current.then(() => AsyncStorage.setItem(SERVER_STORAGE_KEY, url))
      .then(() => {
        if (providerMounted.current && generation === storageGeneration.current) setServerStorageError(null);
      }).catch(() => {
        if (providerMounted.current && generation === storageGeneration.current) {
          setServerStorageError('Server selected, but the URL could not be saved on this device.');
        }
      });
  };

  const clearIdentity = (url: string, mode: BackendMode, generation: number) => {
    const newKey = `${sessionKey(url, '', generation)}:${runId}`;
    setApiConfig({ baseUrl: url, username: '', password: '', sessionKey: newKey, backendMode: mode, capabilities: LEGACY_CAPABILITIES });
    void queryClient.cancelQueries();
    queryClient.clear();
    setUser(null);
    setUsername('');
    setCapabilities(LEGACY_CAPABILITIES);
    setKey(newKey);
    setError(null);
  };

  const setServerUrl = (url: string, mode: BackendMode = backendMode) => {
    const selected = normalizeServerUrl(url, allowLocalHttp);
    if (selected !== baseUrl || mode !== backendMode) {
      const attempt = guard.current.invalidate();
      clearIdentity(selected, mode, attempt.generation);
      setIsLoading(false);
    }
    setBaseUrl(selected);
    setBackendMode(mode);
    persistUrl(selected);
  };

  const login = async (name: string, password: string, customUrl = baseUrl, mode: BackendMode = backendMode) => {
    const url = normalizeServerUrl(customUrl, allowLocalHttp);
    const handle = name.trim();
    if (!handle || !password || /[:\r\n]/.test(handle) || /[\r\n]/.test(password)) {
      throw new Error('Enter a handle without colons and a nonempty password.');
    }
    const attempt = guard.current.begin();
    clearIdentity(url, mode, attempt.generation);
    setBaseUrl(url);
    setBackendMode(mode);
    persistUrl(url);
    setIsLoading(true);
    const config: ApiConfig = { baseUrl: url, username: handle, password, backendMode: mode, signal: attempt.signal };
    try {
      const supported = mode === 'included'
        ? await getServerCapabilities({ config: { ...config, username: '', password: '' }, signal: attempt.signal })
        : LEGACY_CAPABILITIES;
      if (!guard.current.isCurrent(attempt)) throw abortError();
      const profile = await userApi.getUserProfile(undefined, { config, signal: attempt.signal });
      if (!guard.current.isCurrent(attempt)) throw abortError();
      const authenticatedKey = `${sessionKey(url, profile.id, attempt.generation)}:${runId}`;
      setApiConfig({ ...config, capabilities: supported, sessionKey: authenticatedKey });
      setUsername(handle);
      setUser(profile);
      setCapabilities(supported);
      setKey(authenticatedKey);
      return profile;
    } catch (failure) {
      if (!guard.current.isCurrent(attempt)) throw abortError();
      setError(failure instanceof Error ? failure.message : 'Sign-in failed.');
      setApiConfig({ username: '', password: '' });
      throw failure;
    } finally {
      if (guard.current.isCurrent(attempt)) setIsLoading(false);
    }
  };

  const logout = () => {
    const attempt = guard.current.invalidate();
    clearIdentity(baseUrl, backendMode, attempt.generation);
    setIsLoading(false);
  };

  return <AuthContext.Provider value={{
    user, username, baseUrl, backendMode, capabilities, sessionKey: key, sessionConfig: getApiConfig(),
    isAuthenticated: !!user, isLoading, isRestoringServer, error, serverStorageError, allowLocalHttp,
    login, logout, setServerUrl,
  }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider');
  return value;
}
