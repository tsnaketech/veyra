import type { Handle } from '@sveltejs/kit/hooks';
import { VEYRA_ACCESS_TOKEN, VEYRA_ALLOW_LAN } from '$app/env/private';
import {
  ACCESS_COOKIE,
  accessCookie,
  accessSettings,
  bearerOf,
  decideAccess,
  LOGIN_PATH,
  loginPage,
  sameToken
} from '#lib/server/access.ts';

const settings = accessSettings({ VEYRA_ALLOW_LAN, VEYRA_ACCESS_TOKEN });
const html = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });

export const handle: Handle = async ({ event, resolve }) => {
  const { request } = event;
  const decision = decideAccess(settings, {
    method: request.method,
    address: event.getClientAddress(),
    host: request.headers.get('host'),
    origin: request.headers.get('origin'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    bearer: bearerOf(request.headers.get('authorization')),
    cookie: event.cookies.get(ACCESS_COOKIE) ?? null
  });
  // LAN client without a valid token: login form (token sent in a POST body, never a URL).
  if (!decision.allow && decision.status === 401) {
    if (event.url.pathname === LOGIN_PATH && request.method === 'POST') {
      const form = await request.formData().catch(() => null);
      const token = form?.get('token');
      if (typeof token === 'string' && sameToken(token, settings.token))
        // Fixed target: no open redirect.
        return new Response(null, {
          status: 303,
          headers: { location: '/', 'set-cookie': accessCookie(settings.token!) }
        });
      return html(loginPage('Jeton invalide.'), 401);
    }
    return html(loginPage(), 401);
  }
  if (!decision.allow)
    return new Response(decision.reason, {
      status: decision.status,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  if (event.url.pathname === LOGIN_PATH)
    return new Response(null, { status: 303, headers: { location: '/' } });
  return resolve(event);
};
