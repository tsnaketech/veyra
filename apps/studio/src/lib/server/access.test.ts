import { describe, expect, it } from 'vitest';
import {
  accessCookie,
  accessSettings,
  bearerOf,
  decideAccess,
  hostName,
  isLoopback,
  readCookie,
  type AccessRequest
} from './access';

const token = 'A'.repeat(20) + 'b_c-0123456789';
const local: AccessRequest = {
  method: 'GET',
  address: '127.0.0.1',
  host: '127.0.0.1:5173',
  origin: null,
  secFetchSite: null,
  bearer: null,
  cookie: null
};
const lan: AccessRequest = { ...local, address: '192.168.1.20', host: '192.168.1.115:5173' };
const lanOn = accessSettings({ VEYRA_ALLOW_LAN: '1', VEYRA_ACCESS_TOKEN: token });

describe('Studio access policy (T136, T136b)', () => {
  it('serves the local machine through a loopback host name', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.1.1'])
      expect(isLoopback(address)).toBe(true);
    for (const host of ['127.0.0.1:5173', 'localhost:4173', '[::1]:5173', 'LOCALHOST'])
      expect(decideAccess(accessSettings({}), { ...local, host })).toEqual({ allow: true });
    expect(hostName('[::1]:5173')).toBe('[::1]');
  });

  it('refuses a loopback client with a foreign Host (DNS rebinding, unexpected relay)', () => {
    for (const host of ['evil.example', 'evil.example:5173', '192.168.1.115:5173', null])
      expect(decideAccess(accessSettings({}), { ...local, host })).toMatchObject({
        allow: false,
        status: 403
      });
  });

  it('refuses cross-site writes in every mode (SvelteKit skips its origin check in dev)', () => {
    for (const settings of [accessSettings({}), lanOn])
      for (const request of [
        { ...local, method: 'POST', origin: 'http://evil.example' },
        { ...local, method: 'POST', secFetchSite: 'cross-site' },
        { ...local, method: 'DELETE', origin: 'null' },
        { ...lan, method: 'POST', origin: 'http://evil.example', bearer: token }
      ])
        expect(decideAccess(settings, request)).toMatchObject({ allow: false, status: 403 });
    // Same-origin writes and safe cross-site reads still work.
    expect(
      decideAccess(accessSettings({}), {
        ...local,
        method: 'POST',
        origin: 'http://127.0.0.1:5173',
        secFetchSite: 'same-origin'
      })
    ).toEqual({ allow: true });
    expect(decideAccess(accessSettings({}), { ...local, secFetchSite: 'cross-site' })).toEqual({
      allow: true
    });
  });

  it('refuses any other client by default, even with the right token', () => {
    for (const address of ['192.168.1.20', '10.0.0.2', '::ffff:192.168.1.20', '2a01:cb05::1'])
      expect(
        decideAccess(accessSettings({ VEYRA_ACCESS_TOKEN: token }), {
          ...lan,
          address,
          bearer: token
        })
      ).toMatchObject({ allow: false, status: 403 });
  });

  it('fails closed when LAN access is enabled without a strong token', () => {
    for (const bad of [undefined, '', 'short', 'x'.repeat(31), 'a'.repeat(40) + ';Path=/'])
      expect(
        decideAccess(accessSettings({ VEYRA_ALLOW_LAN: '1', VEYRA_ACCESS_TOKEN: bad }), {
          ...lan,
          bearer: bad ?? null
        })
      ).toMatchObject({ allow: false, status: 503 });
  });

  it('asks a LAN client for the exact token (header or cookie); no token in URLs', () => {
    expect(decideAccess(lanOn, lan)).toMatchObject({ allow: false, status: 401 });
    for (const wrong of [token.slice(0, -1) + 'x', token + 'x', token.toLowerCase()])
      expect(decideAccess(lanOn, { ...lan, bearer: wrong })).toMatchObject({ status: 401 });
    expect(decideAccess(lanOn, { ...lan, bearer: token })).toEqual({ allow: true });
    expect(decideAccess(lanOn, { ...lan, cookie: token })).toEqual({ allow: true });
    expect(accessCookie(token)).toMatch(/HttpOnly; SameSite=Strict/);
  });

  it('parses headers strictly', () => {
    expect(bearerOf(`Bearer ${token}`)).toBe(token);
    expect(bearerOf(`bearer ${token}`)).toBe(token);
    expect(bearerOf(`Basic ${token}`)).toBeNull();
    expect(readCookie(`a=1; veyra_access=${token}; b=2`, 'veyra_access')).toBe(token);
    expect(readCookie('xveyra_access=1', 'veyra_access')).toBeNull();
  });

  it('only "1" enables LAN access', () => {
    for (const value of ['true', 'yes', '0', ' 1'])
      expect(accessSettings({ VEYRA_ALLOW_LAN: value }).allowLan).toBe(false);
  });
});
