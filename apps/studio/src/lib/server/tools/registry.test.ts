import { expect, it } from 'vitest';
import { z } from 'zod';
import { permissionClassSchema, toolMetaSchema, toolResultSchema } from '@veyra/schemas';
import { createToolRegistry, defineTool, studioTools, type ToolContext } from './index';

// Registry behaviour only: the tools below that need no Studio service get an empty context.
const ctx = { projectId: 'prj_test', storage: { root: '/srv/veyra-root' } } as ToolContext;
const all = permissionClassSchema.options;
const meta = {
  id: 'test.echo',
  version: 1,
  description: 'Outil de test',
  requires: [],
  capabilities: [],
  permissions: ['read-only' as const],
  sideEffects: 'none' as const,
  network: 'none' as const,
  cost: { kind: 'free' as const },
  limits: { timeoutMs: 100 },
  produces: [],
  validation: ['zod'],
  deterministic: true
};
let runs = 0;
const echo = defineTool({
  meta,
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
  run: async ({ n }) => (runs++, { n })
});
// Declares an output it does not produce.
const liar = defineTool({
  meta: { ...meta, id: 'test.liar' },
  input: z.object({}),
  output: z.object({ n: z.number() }),
  run: async () => ({ n: 'x' }) as never
});
const slow = defineTool({
  meta: { ...meta, id: 'test.slow', limits: { timeoutMs: 30 } },
  input: z.object({}),
  output: z.object({}),
  run: () => new Promise<Record<string, never>>((resolve) => setTimeout(() => resolve({}), 1000))
});
const leaky = defineTool({
  meta: { ...meta, id: 'test.leaky' },
  input: z.object({}),
  output: z.object({}),
  run: async () => {
    throw new Error(`boom ${process.env.VEYRA_TEST_API_KEY}\n    at secret.ts:1:1`);
  }
});

it('(a) lists every Studio tool with its validated meta and JSON Schemas', () => {
  const listed = createToolRegistry(ctx, studioTools).list();
  expect(listed.map((t) => t.meta.id).sort()).toEqual(
    [
      'alignment.ctc',
      'audio.track.update',
      'captions.build',
      'captions.export',
      'composition.check',
      'media.frame',
      'media.inspect',
      'revision.apply',
      'scene.patch',
      'transcription.local-asr',
      'voice.local-tts'
    ].sort()
  );
  for (const tool of listed) {
    expect(toolMetaSchema.parse(tool.meta)).toEqual(tool.meta);
    for (const schema of [tool.input, tool.output]) {
      expect(schema.$schema).toMatch(/json-schema/);
      expect(schema.type).toBe('object');
    }
    // Model-facing inputs take identifiers and bounded values, never paths or argv.
    for (const key of Object.keys(tool.input.properties ?? {}))
      expect(['path', 'argv', 'command', 'args']).not.toContain(key);
  }
  expect(listed.find((t) => t.meta.id === 'media.frame')!.input).toMatchObject({
    required: ['revisionId', 'frameIndex'],
    additionalProperties: false
  });
});

it('refuses an unknown tool and a non-JSON or invalid input without running anything', async () => {
  const registry = createToolRegistry(ctx, [echo]);
  runs = 0;
  expect(await registry.invoke('test.nope', {}, { grants: all })).toMatchObject({
    ok: false,
    toolVersion: null,
    error: { code: 'unknown-tool' }
  });
  const bad = await registry.invoke('test.echo', { n: 'deux' }, { grants: all });
  expect(bad).toMatchObject({ ok: false, error: { code: 'invalid-input', retryable: false } });
  expect(bad.inputHash).toMatch(/^[a-f0-9]{64}$/);
  const lossy = await registry.invoke('test.echo', { n: 1, f: () => 1 }, { grants: all });
  expect(lossy).toMatchObject({ ok: false, inputHash: null, error: { code: 'invalid-input' } });
  expect(runs).toBe(0);
  const ok = await registry.invoke('test.echo', { n: 2 }, { grants: ['read-only'] });
  expect(ok).toMatchObject({ ok: true, output: { n: 2 }, simulated: false, artefacts: [] });
  expect(runs).toBe(1);
  // Every call, refused or not, is in the history as a valid ToolResult.
  expect(registry.history).toHaveLength(4);
  for (const result of registry.history) toolResultSchema.parse(result);
});

it('reports invalid output, timeout and failure as structured errors without stack or secret', async () => {
  process.env.VEYRA_TEST_API_KEY = 'sk-test-should-not-leak';
  try {
    const registry = createToolRegistry(ctx, [liar, slow, leaky]);
    expect(await registry.invoke('test.liar', {}, { grants: all })).toMatchObject({
      ok: false,
      error: { code: 'invalid-output' }
    });
    expect(await registry.invoke('test.slow', {}, { grants: all })).toMatchObject({
      ok: false,
      error: { code: 'timeout', retryable: true }
    });
    const failed = await registry.invoke('test.leaky', {}, { grants: all });
    expect(failed).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(JSON.stringify(failed)).not.toMatch(/sk-test-should-not-leak|secret\.ts|\n/);
  } finally {
    delete process.env.VEYRA_TEST_API_KEY;
  }
});

it('(d) a missing permission is refused before availability and run', async () => {
  const registry = createToolRegistry(ctx, [echo]);
  runs = 0;
  expect(await registry.invoke('test.echo', { n: 1 }, { grants: ['local-compute'] })).toMatchObject(
    { ok: false, error: { code: 'permission-denied', details: { missing: ['read-only'] } } }
  );
  expect(runs).toBe(0);
});

it('(f) unregistered engines answer unavailable with a reason and an install hint', async () => {
  const registry = createToolRegistry(ctx, studioTools);
  const inputs = {
    'voice.local-tts': { revisionId: 'rev_x', sceneId: 'scn_x' },
    'transcription.local-asr': { assetId: 'ast_x' },
    'alignment.ctc': { revisionId: 'rev_x', sceneId: 'scn_x' }
  };
  for (const [id, input] of Object.entries(inputs)) {
    const result = await registry.invoke(id, input, { grants: all });
    expect(result).toMatchObject({ ok: false, simulated: false, error: { code: 'unavailable' } });
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toMatch(/indisponible : \S/);
    expect(result.error.installHint).toBeTruthy();
  }
});

it('review D1: deep or oversized inputs are refused, never thrown', async () => {
  const registry = createToolRegistry(ctx, [echo]);
  let deep: unknown = 1;
  for (let i = 0; i < 20000; i++) deep = { x: deep };
  expect(await registry.invoke('test.echo', { n: 1, deep }, { grants: all })).toMatchObject({
    ok: false,
    error: { code: 'invalid-input' }
  });
  const big = await registry.invoke(
    'test.echo',
    { n: 1, pad: 'x'.repeat(300 * 1024) },
    { grants: all }
  );
  expect(big).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  expect(big.ok || big.error.message).toMatch(/trop volumineuse/);
});

it('review D2: a timeout is retryable only for a tool without side effects', async () => {
  const writer = defineTool({
    meta: { ...meta, id: 'test.writer', sideEffects: 'revision', limits: { timeoutMs: 30 } },
    input: z.object({}),
    output: z.object({}),
    run: () => new Promise<Record<string, never>>((resolve) => setTimeout(() => resolve({}), 500))
  });
  const result = await createToolRegistry(ctx, [slow, writer]).invoke(
    'test.writer',
    {},
    { grants: all }
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'timeout', retryable: false } });
  expect(result.ok || result.error.message).toMatch(/peut se poursuivre/);
});

it('review D3: secrets are masked before truncation, with the executor rule, short ones too', async () => {
  const long = 'L'.repeat(290) + 'TAILSECRET1234567890';
  Object.assign(process.env, {
    GITHUB_PAT: 'ghp-should-not-leak',
    VEYRA_SHORT_TOKEN: 'abcd',
    VEYRA_LONG_KEY: long
  });
  try {
    const leaky2 = defineTool({
      meta: { ...meta, id: 'test.leaky2' },
      input: z.object({}),
      output: z.object({}),
      run: async () => {
        throw new Error(`${long} ghp-should-not-leak abcd /srv/veyra-root/prj_x/a.mp4`);
      }
    });
    const failed = await createToolRegistry(ctx, [leaky2]).invoke(
      'test.leaky2',
      {},
      { grants: all }
    );
    const text = JSON.stringify(failed);
    expect(text).not.toMatch(/ghp-should-not-leak|LLLLLLLLLL|TAILSECRET|abcd|\/srv\/veyra-root/);
    expect(text).toContain('<projets>');
  } finally {
    for (const key of ['GITHUB_PAT', 'VEYRA_SHORT_TOKEN', 'VEYRA_LONG_KEY'])
      delete process.env[key];
  }
});

it('review D4: grants are validated at runtime (no substring match)', async () => {
  const registry = createToolRegistry(ctx, [echo]);
  for (const grants of ['read-only local-compute', ['read-only', 'root'], null])
    expect(await registry.invoke('test.echo', { n: 1 }, { grants: grants as never })).toMatchObject(
      { ok: false, error: { code: 'permission-denied' } }
    );
});

it('review D5: a registry serves one project', () => {
  expect(() => createToolRegistry({ ...ctx, projectId: 'nope' } as ToolContext, [echo])).toThrow();
});
