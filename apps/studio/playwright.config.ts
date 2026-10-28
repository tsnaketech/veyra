import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// Fresh database and media root per run; the simulated AI is explicit and labelled in the UI.
const root = process.env.VEYRA_E2E_ROOT ?? mkdtempSync(join(tmpdir(), 'veyra-e2e-'));
process.env.VEYRA_E2E_ROOT = root;

export default defineConfig({
  testMatch: '**/*.e2e.{ts,js}',
  timeout: 300_000,
  workers: 1,
  use: { baseURL: 'http://localhost:4173' },
  webServer: {
    // exec: Playwright stops the server process itself instead of an intermediate pnpm shell.
    command:
      'node_modules/.bin/vite build && exec node_modules/.bin/vite preview --port 4173 --strictPort',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    port: 4173,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: join(root, 'e2e.db'),
      VEYRA_PROJECTS_ROOT: join(root, 'projects'),
      VEYRA_AI_PROVIDER: 'fake',
      HYPERFRAMES_TELEMETRY: '0',
      DO_NOT_TRACK: '1'
    }
  }
});
