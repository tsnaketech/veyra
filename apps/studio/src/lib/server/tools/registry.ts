import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { z } from 'zod';
import type { VideoEngine } from '@veyra/hyperframes-adapter';
import { inputHash } from '@veyra/schemas/hash';
import {
  newId,
  toolMetaSchema,
  toolResultSchema,
  type PermissionClass,
  type ToolArtefact,
  type ToolError,
  type ToolMeta,
  type ToolResult
} from '@veyra/schemas';
import { safePath, validateId, type ProjectStorage } from '@veyra/storage';
import type { createRepository } from '../db/repo';
import type { Studio, StudioSettings } from '../studio';

export interface ToolContext {
  repo: ReturnType<typeof createRepository>;
  storage: ProjectStorage;
  settings: StudioSettings;
  /** HyperFramesEngine in the Studio; a test engine in unit tests. */
  engine: VideoEngine;
  /** For tools that must reuse a Studio flow (child revisions). */
  studio: Studio;
}
export interface CallContext extends ToolContext {
  /** Path of a new file in this call's own folder `<prj>/tool-calls/<tcl_…>/` (never a revision folder). */
  artefactPath(projectId: string, name: string): string;
  /** Adds a written file to the call's manifest (sha256, path relative to the storage root). */
  recordArtefact(kind: string, path: string): void;
}
export type Availability = { ok: boolean; reason?: string; installHint?: string };
export interface Tool {
  meta: ToolMeta;
  input: z.ZodType;
  output: z.ZodType;
  simulated: boolean;
  available(ctx: ToolContext): Availability | Promise<Availability>;
  run(input: unknown, ctx: CallContext): Promise<unknown>;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: {
  meta: ToolMeta;
  input: I;
  output: O;
  /** Set only by a tool whose output is a labelled demonstration. */
  simulated?: boolean;
  available?(ctx: ToolContext): Availability | Promise<Availability>;
  run(input: z.output<I>, ctx: CallContext): Promise<z.input<O>>;
}): Tool {
  return {
    meta: toolMetaSchema.parse(def.meta),
    input: def.input,
    output: def.output,
    simulated: def.simulated ?? false,
    available: def.available ?? (() => ({ ok: true })),
    run: (input, ctx) => def.run(input as z.output<I>, ctx)
  };
}

class ToolTimeout extends Error {}
// Error text only (no stack); values of secret-looking parent variables are masked.
function safeMessage(error: unknown) {
  let text = (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300);
  for (const [key, value] of Object.entries(process.env))
    if (value && value.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key))
      text = text.split(value).join('***');
  return text || 'erreur inconnue';
}

export function createToolRegistry(ctx: ToolContext, tools: Tool[]) {
  const byId = new Map(tools.map((tool) => [tool.meta.id, tool]));
  if (byId.size !== tools.length) throw new Error('Duplicate tool id');
  /** In-memory call log for tests and the future Director loop (persisted with T129). */
  const history: ToolResult[] = [];

  function list() {
    return tools.map((tool) => ({
      meta: tool.meta,
      input: z.toJSONSchema(tool.input, { io: 'input' }),
      output: z.toJSONSchema(tool.output)
    }));
  }

  async function invoke(
    id: string,
    rawInput: unknown,
    { grants }: { grants: readonly PermissionClass[] }
  ): Promise<ToolResult> {
    const started = performance.now();
    const tool = byId.get(id);
    let hash: string | null = null;
    try {
      hash = inputHash(rawInput);
    } catch {
      // Not plain JSON: refused below as invalid-input.
    }
    const artefacts: ToolArtefact[] = [];
    const done = (outcome: { output: unknown } | { error: ToolError }) => {
      const result = toolResultSchema.parse({
        ok: 'output' in outcome,
        toolId: id,
        toolVersion: tool?.meta.version ?? null,
        inputHash: hash,
        durationMs: performance.now() - started,
        artefacts,
        simulated: tool?.simulated ?? false,
        ...outcome
      });
      history.push(result);
      return result;
    };
    const fail = (code: ToolError['code'], message: string, extra: Partial<ToolError> = {}) =>
      done({ error: { code, message, retryable: false, ...extra } });

    if (!tool) return fail('unknown-tool', `Outil inconnu : ${id}`);
    const parsed = tool.input.safeParse(rawInput);
    if (hash === null || !parsed.success)
      return fail('invalid-input', 'Entrée refusée par le schéma de l’outil', {
        ...(parsed.success ? {} : { details: z.treeifyError(parsed.error) as z.core.util.JSONType })
      });
    const missing = tool.meta.permissions.filter((p) => !grants.includes(p));
    if (missing.length)
      return fail('permission-denied', `Permission non accordée : ${missing.join(', ')}`, {
        details: { missing }
      });
    const availability = await tool.available(ctx);
    if (!availability.ok)
      return fail(
        'unavailable',
        `Outil indisponible : ${availability.reason ?? 'raison inconnue'}`,
        {
          ...(availability.installHint ? { installHint: availability.installHint } : {})
        }
      );

    const callId = newId('tcl');
    const call: CallContext = {
      ...ctx,
      artefactPath(projectId, name) {
        const dir = safePath(ctx.storage.root, validateId(projectId, 'prj'), 'tool-calls', callId);
        mkdirSync(dir, { recursive: true });
        // Re-check after creation: nothing on the way may be a symlink.
        return safePath(ctx.storage.root, validateId(projectId, 'prj'), 'tool-calls', callId, name);
      },
      recordArtefact(kind, path) {
        const checked = safePath(ctx.storage.root, relative(ctx.storage.root, path));
        artefacts.push({
          kind,
          path: relative(ctx.storage.root, checked),
          sha256: createHash('sha256').update(readFileSync(checked)).digest('hex')
        });
      }
    };
    let timer: NodeJS.Timeout | undefined;
    let output: unknown;
    try {
      // shortcut: the timeout ends the call, not a child already started (bounded by its own
      // runProcess timeout); pass an AbortSignal through the executor when T129 needs it.
      output = await Promise.race([
        tool.run(parsed.data, call),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ToolTimeout()), tool.meta.limits.timeoutMs);
        })
      ]);
    } catch (error) {
      return error instanceof ToolTimeout
        ? fail('timeout', `Délai dépassé (${tool.meta.limits.timeoutMs} ms)`, { retryable: true })
        : fail('failed', `Échec de l’outil : ${safeMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
    const checked = tool.output.safeParse(output);
    if (!checked.success)
      return fail('invalid-output', 'Sortie de l’outil non conforme à son schéma', {
        details: z.treeifyError(checked.error) as z.core.util.JSONType
      });
    const bytes = Buffer.byteLength(JSON.stringify(checked.data) ?? '');
    const max = tool.meta.limits.outputBytes;
    if (max && bytes > max)
      return fail('invalid-output', `Sortie trop volumineuse (${bytes} > ${max} octets)`);
    return done({ output: checked.data });
  }

  return { list, invoke, history };
}
export type ToolRegistry = ReturnType<typeof createToolRegistry>;
