import type { Handle } from '@sveltejs/kit/hooks';
import { VEYRA_ACCESS_TOKEN, VEYRA_ALLOW_LAN } from '$app/env/private';
import { ACCESS_COOKIE, accessSettings, decideAccess } from '#lib/server/access.ts';

const settings = accessSettings({ VEYRA_ALLOW_LAN, VEYRA_ACCESS_TOKEN });

export const handle: Handle = async ({ event, resolve }) => {
  const header = event.request.headers.get('authorization');
  const decision = decideAccess(settings, {
    address: event.getClientAddress(),
    bearer: header?.startsWith('Bearer ') ? header.slice(7) : null,
    cookie: event.cookies.get(ACCESS_COOKIE) ?? null,
    queryToken: event.url.searchParams.get('access')
  });
  if (!decision.allow)
    return new Response(decision.reason, {
      status: decision.status,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  if (decision.setCookie) {
    // Drop the token from the address bar and history.
    const clean = new URL(event.url);
    clean.searchParams.delete('access');
    return new Response(null, {
      status: 303,
      headers: { location: clean.pathname + clean.search, 'set-cookie': decision.setCookie }
    });
  }
  return resolve(event);
};
