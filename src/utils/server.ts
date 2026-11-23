export const SERVER_PRESETS = [
  { url: 'http://localhost:3000', label: 'localhost:3000' },
  { url: 'http://127.0.0.1:3000', label: '127.0.0.1:3000' },
  { url: 'http://10.0.2.2:3000', label: 'Android emulator' },
];

export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || /^(?:fc|fd)[0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 127 || parts[0] === 10 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 169 && parts[1] === 254);
}

export function normalizeServerUrl(value: string, allowLocalHttp = false): string {
  let url: URL;
  try {
    if (/\s/.test(value.trim()) || /[\u0000-\u001f\u007f\\]/.test(value)) throw new Error();
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter a full API URL, such as https://chat.example.edu or http://192.168.1.20:3000 for local development.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP(S) API URL without credentials, query parameters, or a fragment.');
  }
  if (url.protocol === 'http:' && (!allowLocalHttp || !isLocalHost(url.hostname))) {
    throw new Error('HTTPS is required. HTTP is allowed only for local development servers with test credentials.');
  }
  return url.toString().replace(/\/+$/, '');
}
