import { timingSafeEqual } from 'node:crypto';

/**
 * Who may use the Studio (T136, hardened by T136b). It is a single-user local tool
 * without accounts. One pure policy, applied twice: by a Vite plugin in front of every
 * dev/preview middleware and upgrade (Vite serves sources, static files and HMR before
 * SvelteKit's hook), and by the SvelteKit `handle` hook.
 * - Loopback clients are allowed only with a loopback Host header (DNS rebinding).
 * - Other clients are refused unless LAN access is explicitly enabled AND they present
 *   the access token (Bearer header or HttpOnly cookie set by a POST login form).
 * - Unsafe methods are refused when cross-site (SvelteKit skips its origin check in dev).
 */
export const ACCESS_COOKIE = 'veyra_access';
export const LOGIN_PATH = '/__veyra/access';
/** Largest login body read before authentication (a form with one token field). */
export const MAX_LOGIN_BYTES = 4096;
/** Unauthenticated login bodies must declare a small Content-Length (no chunked bodies). */
export const loginBodyAllowed = (contentLength: string | null | undefined) =>
  /^\d+$/.test(contentLength ?? '') && Number(contentLength) <= MAX_LOGIN_BYTES;
export const MIN_TOKEN_LENGTH = 32;

export interface AccessSettings {
  allowLan: boolean;
  token: string | null;
}
export interface AccessRequest {
  method: string;
  /** Client IP as seen on the socket; proxy headers are never trusted. */
  address: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  bearer: string | null;
  cookie: string | null;
}
export type AccessDecision =
  { allow: true } | { allow: false; status: 401 | 403 | 503; reason: string };

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
export const isLoopback = (address: string) => LOOPBACK.test(address.trim());
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Hostname part of a Host header ("[::1]:5173" → "[::1]", "127.0.0.1:5173" → "127.0.0.1"). */
export const hostName = (host: string) => host.trim().toLowerCase().replace(/:\d+$/, '');
const TOKEN = new RegExp(`^[A-Za-z0-9_-]{${MIN_TOKEN_LENGTH},}$`);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function accessSettings(env: { VEYRA_ALLOW_LAN?: string; VEYRA_ACCESS_TOKEN?: string }) {
  const token = env.VEYRA_ACCESS_TOKEN?.trim() || null;
  return { allowLan: env.VEYRA_ALLOW_LAN === '1', token } satisfies AccessSettings;
}
export const strongToken = (settings: AccessSettings) =>
  settings.token !== null && TOKEN.test(settings.token);

export function sameToken(given: string | null | undefined, expected: string | null) {
  if (!given || !expected) return false;
  const a = Buffer.from(given),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const deny = (status: 401 | 403 | 503, reason: string): AccessDecision => ({
  allow: false,
  status,
  reason
});
const originHost = (origin: string) => {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
};

export function decideAccess(settings: AccessSettings, request: AccessRequest): AccessDecision {
  // Cross-site writes (CSRF) are refused for every client, in every mode.
  if (!SAFE_METHODS.has(request.method.toUpperCase())) {
    if (request.secFetchSite === 'cross-site') return deny(403, 'Requête inter-sites refusée.');
    if (
      request.origin &&
      (!request.host || originHost(request.origin) !== request.host.trim().toLowerCase())
    )
      return deny(403, 'Origine de la requête refusée.');
  }
  if (isLoopback(request.address)) {
    // A loopback client with a foreign Host is a rebound DNS name or an unexpected relay.
    if (!request.host || !LOOPBACK_HOSTS.has(hostName(request.host)))
      return deny(403, 'Nom d’hôte refusé : utiliser http://127.0.0.1 ou http://localhost.');
    return { allow: true };
  }
  if (!settings.allowLan)
    return deny(
      403,
      'Accès réseau désactivé : le Studio n’accepte que la machine locale (VEYRA_ALLOW_LAN).'
    );
  // Fail closed: LAN mode without a strong token serves nobody but loopback.
  if (!strongToken(settings))
    return deny(
      503,
      `Accès réseau mal configuré : VEYRA_ACCESS_TOKEN doit faire au moins ${MIN_TOKEN_LENGTH} caractères parmi A–Z, a–z, 0–9, « _ » et « - ».`
    );
  if (sameToken(request.bearer, settings.token) || sameToken(request.cookie, settings.token))
    return { allow: true };
  return deny(401, 'Jeton d’accès requis.');
}

/** Cookie set after a successful POST to LOGIN_PATH (the token never travels in a URL). */
export const accessCookie = (token: string) =>
  `${ACCESS_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`;

export const loginPage = (
  error = ''
) => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>Veyra — accès</title></head>
<body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">
<h1>Accès au Studio</h1><p>Ce Studio n’accepte les clients du réseau qu’avec son jeton d’accès.</p>
${error ? `<p role="alert">${error}</p>` : ''}
<form method="post" action="${LOGIN_PATH}"><label>Jeton <input name="token" type="password" autocomplete="off" required></label>
<button type="submit">Entrer</button></form></body></html>`;

export function readCookie(header: string | null | undefined, name: string) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}
export const bearerOf = (header: string | null | undefined) =>
  header && /^bearer /i.test(header) ? header.slice(7).trim() : null;
