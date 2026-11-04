import { timingSafeEqual } from 'node:crypto';

/**
 * Who may use the Studio (T136). It is a single-user local tool without accounts:
 * loopback clients are always allowed; any other client is refused unless LAN access
 * was explicitly enabled AND it presents the access token (header or cookie).
 * Defense in depth: the dev and preview servers also bind 127.0.0.1 by default.
 */
export const ACCESS_COOKIE = 'veyra_access';
export const MIN_TOKEN_LENGTH = 32;

export interface AccessSettings {
  allowLan: boolean;
  token: string | null;
}
export type AccessDecision =
  { allow: true; setCookie?: string } | { allow: false; status: 403 | 503; reason: string };

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
export const isLoopback = (address: string) => LOOPBACK.test(address.trim());

export function accessSettings(env: { VEYRA_ALLOW_LAN?: string; VEYRA_ACCESS_TOKEN?: string }) {
  const token = env.VEYRA_ACCESS_TOKEN?.trim() || null;
  return { allowLan: env.VEYRA_ALLOW_LAN === '1', token } satisfies AccessSettings;
}

const sameToken = (given: string | null | undefined, expected: string) => {
  if (!given) return false;
  const a = Buffer.from(given),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function decideAccess(
  settings: AccessSettings,
  request: {
    address: string;
    bearer: string | null;
    cookie: string | null;
    queryToken: string | null;
  }
): AccessDecision {
  if (isLoopback(request.address)) return { allow: true };
  if (!settings.allowLan)
    return {
      allow: false,
      status: 403,
      reason:
        'Accès réseau désactivé : le Studio n’accepte que la machine locale (VEYRA_ALLOW_LAN).'
    };
  // Fail closed: LAN mode without a strong token serves nobody but loopback.
  // The token goes into a cookie: URL-safe characters only, so it cannot break the header.
  if (!settings.token || !new RegExp(`^[A-Za-z0-9_-]{${MIN_TOKEN_LENGTH},}$`).test(settings.token))
    return {
      allow: false,
      status: 503,
      reason: `Accès réseau mal configuré : VEYRA_ACCESS_TOKEN doit faire au moins ${MIN_TOKEN_LENGTH} caractères parmi A–Z, a–z, 0–9, « _ » et « - ».`
    };
  if (sameToken(request.bearer, settings.token) || sameToken(request.cookie, settings.token))
    return { allow: true };
  // One-time link (?access=…) sets an HttpOnly cookie so the token leaves the URL.
  if (sameToken(request.queryToken, settings.token))
    return {
      allow: true,
      setCookie: `${ACCESS_COOKIE}=${settings.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`
    };
  return { allow: false, status: 403, reason: 'Jeton d’accès manquant ou invalide.' };
}
