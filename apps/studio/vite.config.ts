import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-auto';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import type { IncomingMessage } from 'node:http';
import {
  ACCESS_COOKIE,
  accessSettings,
  bearerOf,
  decideAccess,
  LOGIN_PATH,
  loginPage,
  readCookie
} from './src/lib/server/access.ts';

/**
 * T136b: Vite serves sources (/src, /@fs), static files and the HMR socket before
 * SvelteKit's hook ever runs, so the same access policy guards every middleware and
 * upgrade here; the hook keeps guarding SvelteKit itself (and serves the login form).
 */
function accessGuard(): Plugin {
  let settings = accessSettings(process.env);
  const check = (req: IncomingMessage) =>
    decideAccess(settings, {
      method: req.method ?? 'GET',
      address: req.socket.remoteAddress ?? '',
      host: req.headers.host ?? null,
      origin: req.headers.origin ?? null,
      secFetchSite: (req.headers['sec-fetch-site'] as string | undefined) ?? null,
      bearer: bearerOf(req.headers.authorization),
      cookie: readCookie(req.headers.cookie, ACCESS_COOKIE)
    });
  const install = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((req, res, next) => {
      const decision = check(req);
      if (decision.allow) return next();
      // Only the login path reaches SvelteKit without a token (its hook checks the POST).
      if (decision.status === 401 && (req.url ?? '').split('?')[0] === LOGIN_PATH) return next();
      res.statusCode = decision.status;
      res.setHeader('cache-control', 'no-store');
      if (decision.status === 401) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(loginPage());
      } else {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(decision.reason);
      }
    });
    server.httpServer?.prependListener('upgrade', (req: IncomingMessage, socket) => {
      if (!check(req).allow) socket.destroy();
    });
  };
  return {
    name: 'veyra-access',
    configResolved(config) {
      // Same variables SvelteKit's private env sees (Vite's mode files, then the process).
      settings = accessSettings({
        ...loadEnv(config.mode, config.envDir || process.cwd(), ''),
        ...process.env
      });
    },
    configureServer: install,
    configurePreviewServer: install
  };
}

export default defineConfig({
  // Loaded from node_modules at runtime; bundling it pulls optional OpenTelemetry imports.
  ssr: { external: ['@anthropic-ai/sdk'] },
  // Local-first: never listen on the network by default (T136); LAN needs VEYRA_ALLOW_LAN + token.
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  plugins: [
    accessGuard(),
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true
      },

      // adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
      // If your environment is not supported, or you settled on a specific environment, switch out the adapter.
      // See https://svelte.dev/docs/kit/adapters for more information about adapters.
      adapter: adapter()
    })
  ],
  test: {
    expect: { requireAssertions: true },
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'client',
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: 'chromium', headless: true }]
          },
          include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
          exclude: ['src/lib/server/**']
        }
      },

      {
        extends: './vite.config.ts',
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/**/*.{test,spec}.{js,ts}'],
          exclude: ['src/**/*.svelte.{test,spec}.{js,ts}', 'src/**/*.slow.test.ts']
        }
      },

      {
        extends: './vite.config.ts',
        test: {
          // Real HyperFrames renders (bwrap, Chrome headless): run by test:slow only.
          name: 'slow',
          environment: 'node',
          include: ['src/**/*.slow.test.ts']
        }
      }
    ]
  }
});
