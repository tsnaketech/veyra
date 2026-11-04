import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { request } from 'node:http';
import { join } from 'node:path';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/**
 * T136/T136b on real servers (vite preview after a real build, vite dev), bound to all
 * interfaces as with `--host`. Requests sent to this machine's non-loopback address
 * arrive from that address, so the hook sees a LAN client; 127.0.0.1 is the local one.
 * Nothing is mocked; the AI provider is the labelled `fake`.
 */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const studio = join(import.meta.dirname, '../../..');
const vite = join(studio, 'node_modules/.bin/vite');
const PREVIEW = 5197,
  DEV = 5196;
const token = 'Tst_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'; // 36 URL-safe chars, fake.
let root: string;

const killPort = (port: number) => {
  let pids: string;
  try {
    pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  } catch {
    return; // lsof exits 1 when nothing listens.
  }
  for (const pid of pids.split('\n').filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
};

async function start(mode: 'preview' | 'dev', port: number, env: Record<string, string>) {
  killPort(port);
  const child = spawn(vite, [mode, '--host', '0.0.0.0', '--port', String(port), '--strictPort'], {
    cwd: studio,
    detached: true,
    stdio: 'ignore',
    // Minimal env: no parent secrets; explicit values win over any apps/studio/.env.
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? root,
      DATABASE_URL: join(root, `${mode}.db`),
      VEYRA_PROJECTS_ROOT: join(root, 'projects'),
      VEYRA_AI_PROVIDER: 'fake',
      HYPERFRAMES_TELEMETRY: '0',
      DO_NOT_TRACK: '1',
      ...env
    }
  });
  child.unref();
  for (let i = 0; i < 240; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/robots.txt`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`vite ${mode} did not start on ${port}`);
}

const get = (host: string, port: number, path: string, headers: Record<string, string> = {}) =>
  fetch(`http://${host}:${port}${path}`, { headers, redirect: 'manual' });

/** Status of a GET with an arbitrary Host header (fetch forbids setting Host). */
const rawStatus = (address: string, port: number, path: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: address, port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
/** True when a WebSocket upgrade (Vite HMR) is cut before any handshake. */
const upgradeRefused = (address: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const req = request({
      host: address,
      port,
      path: '/',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-protocol': 'vite-hmr'
      }
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(false);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(false);
    });
    req.on('error', () => resolve(true));
    req.end();
  });

describe.skipIf(!lanAddress)(`Studio access on a real server (LAN address ${lanAddress})`, () => {
  const lan = lanAddress!;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'veyra-access-'));
    // Real production build, as the E2E does.
    execFileSync(vite, ['build'], { cwd: studio, stdio: 'ignore', env: process.env });
  });
  afterEach(() => {
    killPort(PREVIEW);
    killPort(DEV);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('preview, default: 403 from the LAN for pages, static files and bundles', async () => {
    await start('preview', PREVIEW, { VEYRA_ALLOW_LAN: '0', VEYRA_ACCESS_TOKEN: token });
    expect((await get('127.0.0.1', PREVIEW, '/')).status).toBe(200);
    const refused = await get(lan, PREVIEW, '/');
    expect(refused.status).toBe(403);
    expect(await refused.text()).toMatch(/VEYRA_ALLOW_LAN/);
    expect((await get(lan, PREVIEW, '/', { authorization: `Bearer ${token}` })).status).toBe(403);
    // T136b: Vite's static and bundle middlewares are guarded too (was a pinned gap).
    const entry = readdirSync(join(studio, '.svelte-kit/output/client/_app/immutable/entry'))[0];
    for (const path of ['/robots.txt', '/_app/version.json', `/_app/immutable/entry/${entry}`])
      expect((await get(lan, PREVIEW, path)).status, path).toBe(403);
    expect((await get('127.0.0.1', PREVIEW, '/robots.txt')).status).toBe(200);
  });

  it('preview, LAN mode: login form, token only in a POST body, cookie, no open redirect', async () => {
    await start('preview', PREVIEW, { VEYRA_ALLOW_LAN: '1', VEYRA_ACCESS_TOKEN: token });
    const form = await get(lan, PREVIEW, '/settings');
    expect(form.status).toBe(401);
    expect(await form.text()).toContain('/__veyra/access');
    expect((await get(lan, PREVIEW, '/robots.txt')).status).toBe(401);
    expect(
      (await get(lan, PREVIEW, '/', { authorization: `Bearer ${token.slice(0, -1)}x` })).status
    ).toBe(401);
    expect((await get(lan, PREVIEW, '/', { authorization: `Bearer ${token}` })).status).toBe(200);
    // The former ?access= link no longer authenticates (tokens never travel in URLs).
    const link = await get(lan, PREVIEW, `/settings?access=${token}`);
    expect(link.status).toBe(401);
    expect(link.headers.get('set-cookie')).toBeNull();

    const login = (value: string) =>
      fetch(`http://${lan}:${PREVIEW}/__veyra/access`, {
        method: 'POST',
        redirect: 'manual',
        // A browser form sends its same-site Origin (SvelteKit's own CSRF check needs it).
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: `http://${lan}:${PREVIEW}`
        },
        body: new URLSearchParams({ token: value })
      });
    expect((await login('wrong')).status).toBe(401);
    const ok = await login(token);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/');
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^veyra_access=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const pair = cookie.split(';')[0];
    expect((await get(lan, PREVIEW, '/', { cookie: pair })).status).toBe(200);
    expect((await get(lan, PREVIEW, '/robots.txt', { cookie: pair })).status).toBe(200);
    expect((await get(lan, PREVIEW, '/', { cookie: 'veyra_access=wrong' })).status).toBe(401);
  });

  it('preview, LAN mode with a weak token: 503 from the LAN, loopback still served', async () => {
    await start('preview', PREVIEW, { VEYRA_ALLOW_LAN: '1', VEYRA_ACCESS_TOKEN: 'short-token' });
    expect((await get(lan, PREVIEW, '/', { authorization: 'Bearer short-token' })).status).toBe(
      503
    );
    expect((await get('127.0.0.1', PREVIEW, '/')).status).toBe(200);
  });

  it('preview: cross-site writes and foreign Host names are refused, even locally', async () => {
    await start('preview', PREVIEW, { VEYRA_ALLOW_LAN: '0' });
    const post = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${PREVIEW}/settings?/check`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: ''
      });
    expect((await post({ origin: 'http://evil.example' })).status).toBe(403);
    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    // DNS rebinding: a loopback client whose Host is a foreign name.
    expect(await rawStatus('127.0.0.1', PREVIEW, '/', 'evil.example')).toBe(403);
    expect(await rawStatus('127.0.0.1', PREVIEW, '/', `localhost:${PREVIEW}`)).toBe(200);
  });

  it('dev: Vite sources, client and HMR socket are guarded like the app', async () => {
    await start('dev', DEV, { VEYRA_ALLOW_LAN: '0' });
    expect((await get('127.0.0.1', DEV, '/')).status).toBe(200);
    expect((await get(lan, DEV, '/')).status).toBe(403);
    for (const path of [
      '/src/hooks.server.ts',
      '/src/lib/server/access.ts',
      '/src/lib/server/db/index.ts',
      '/src/env.ts?raw',
      '/@vite/client',
      '/@fs/etc/passwd'
    ])
      expect((await get(lan, DEV, path)).status, path).toBe(403);
    expect(await upgradeRefused(lan, DEV)).toBe(true);
    // Locally, Vite keeps working.
    expect((await get('127.0.0.1', DEV, '/@vite/client')).status).toBe(200);
  });

  it('dev, LAN mode: sources need the token too', async () => {
    await start('dev', DEV, { VEYRA_ALLOW_LAN: '1', VEYRA_ACCESS_TOKEN: token });
    for (const path of ['/src/lib/server/access.ts', '/@vite/client'])
      expect((await get(lan, DEV, path)).status, path).toBe(401);
    expect(await upgradeRefused(lan, DEV)).toBe(true);
  });
});

it.skipIf(lanAddress)('no non-loopback IPv4 address on this machine: LAN tests skipped', () => {
  expect(lanAddress).toBeUndefined();
});
