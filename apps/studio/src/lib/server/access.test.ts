import { describe, expect, it } from 'vitest';
import { accessSettings, decideAccess, isLoopback } from './access';

const token = 'A'.repeat(20) + 'b_c-0123456789';
const lan = { address: '192.168.1.20', bearer: null, cookie: null, queryToken: null };

describe('Studio access policy (T136)', () => {
  it('always serves the local machine', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.1.1'])
      expect(isLoopback(address)).toBe(true);
    expect(decideAccess(accessSettings({}), { ...lan, address: '::1' })).toEqual({ allow: true });
  });

  it('refuses any other client by default, even with the right token', () => {
    for (const address of [
      '192.168.1.20',
      '10.0.0.2',
      '::ffff:192.168.1.20',
      '2a01:cb05::1',
      '0.0.0.0'
    ])
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

  it('accepts a LAN client only with the exact token (header, cookie or one-time link)', () => {
    const settings = accessSettings({ VEYRA_ALLOW_LAN: '1', VEYRA_ACCESS_TOKEN: token });
    expect(decideAccess(settings, lan)).toMatchObject({ allow: false, status: 403 });
    expect(decideAccess(settings, { ...lan, bearer: token.slice(0, -1) + 'x' })).toMatchObject({
      allow: false
    });
    expect(decideAccess(settings, { ...lan, bearer: token + 'x' })).toMatchObject({ allow: false });
    expect(decideAccess(settings, { ...lan, bearer: token })).toEqual({ allow: true });
    expect(decideAccess(settings, { ...lan, cookie: token })).toEqual({ allow: true });
    const link = decideAccess(settings, { ...lan, queryToken: token });
    expect(link).toMatchObject({ allow: true });
    expect(link.allow && link.setCookie).toMatch(/HttpOnly; SameSite=Strict/);
  });

  it('only "1" enables LAN access', () => {
    for (const value of ['true', 'yes', '0', ' 1'])
      expect(accessSettings({ VEYRA_ALLOW_LAN: value }).allowLan).toBe(false);
  });
});
