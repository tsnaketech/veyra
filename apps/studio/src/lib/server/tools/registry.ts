import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { VideoEngine } from '@veyra/hyperframes-adapter';
import { inputHash } from '@veyra/schemas/hash';
import {
  newId,
  permissionClassSchema,
  toolMetaSchema,
  toolResultSchema,
  type PermissionClass,
  type ToolArtefact,
  type ToolError,
  type ToolMeta,
  type ToolResult
} from '@veyra/schemas';
import { safePath, validateId, type ProjectStorage } from '@veyra/storage';
import { isSecretEnvKey, MEDIA_LIMITS, systemBinary, type ProcessLimits } from '@veyra/video';
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
  /** The registry serves one project: revisions of any other project are refused. */
  projectId: string;
}
export interface CallContext extends ToolContext {
  /** A revision of the registry's project; any other id is refused (permission-denied). */
  revision(revisionId: string): ReturnType<ToolContext['repo']['getRevision']>;
  /** Path of a new file in this call's own folder `<prj>/tool-calls/<tcl_…>/` (never a revision folder). */
  artefactPath(projectId: string, name: string): string;
  /** Adds a written file to the call's manifest (sha256, path relative to the storage root). */
  recordArtefact(kind: string, path: string): void;
  /** Aborted on timeout or by the caller: tools pass it to runProcess (kills the process group). */
  signal: AbortSignal;
  /** prlimit bounds of this tool's child processes (meta.limits over MEDIA_LIMITS). */
  processLimits: ProcessLimits;
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

/**
 * Real presence probe of declared requirements, without running anything: a plain name
 * ("ffmpeg", "bwrap") is a system binary looked up where the executor resolves it;
 * "chrome" is the HyperFrames Chrome cache the sandbox binds; "engine:…" is left to the
 * tool's own available().
 */
export function missingRequirements(requires: readonly string[]) {
  return requires.filter((name) =>
    name === 'chrome'
      ? !existsSync(join(homedir(), '.cache/hyperframes/chrome'))
      : !name.includes(':') && !systemBinary(name)
  );
}
/** In-memory history kept by a registry; the persisted, bounded history is loop_steps (T129a). */
export const MAX_HISTORY = 200;
class ToolTimeout extends Error {}
class ToolCancelled extends Error {}
class ToolDenied extends Error {}
/** Typed refusal raised by a tool after parsing (T128): stale parent, missing target, invalid edit. */
export class ToolFailure extends Error {
  constructor(
    readonly code: 'conflict' | 'invalid-input',
    message: string
  ) {
    super(message);
  }
}
/** Largest accepted input (JSON); deeper or larger inputs are refused before parsing. */
export const MAX_INPUT_BYTES = 256 * 1024;
// Error text only (no stack). Secrets are masked BEFORE truncation (a cut secret would
// leak its start), with the executor's own secret-key rule; host paths are shortened.
function safeMessage(error: unknown, root: string) {
  let text = (error instanceof Error ? error.message : String(error)).split('\n')[0];
  for (const [key, value] of Object.entries(process.env))
    if (value && value.length >= 4 && isSecretEnvKey(key)) text = text.split(value).join('***');
  text = text.split(root).join('<projets>').slice(0, 300);
  return text || 'erreur inconnue';
}

export function createToolRegistry(ctx: ToolContext, tools: Tool[]) {
  validateId(ctx.projectId, 'prj');
  const byId = new Map(tools.map((tool) => [tool.meta.id, tool]));
  if (byId.size !== tools.length) throw new Error('Duplicate tool id');
  /** In-memory call log for tests and the future Director loop (persisted with T129). */
  const history: ToolResult[] = [];
  const meta = (id: string) => byId.get(id)?.meta;

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
    options: { grants: readonly PermissionClass[]; signal?: AbortSignal }
  ): Promise<ToolResult> {
    const started = performance.now();
    const tool = byId.get(id);
    let hash: string | null = null;
    let size = Infinity;
    try {
      // Throws on non-JSON values and on nesting too deep for a recursive walk.
      size = Buffer.byteLength(JSON.stringify(rawInput) ?? '');
      if (size <= MAX_INPUT_BYTES) hash = inputHash(rawInput);
    } catch {
      // Refused below as invalid-input.
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
        cost: { kind: tool?.meta.cost.kind ?? 'free', microUsd: tool?.meta.cost.microUsd ?? 0 },
        ...outcome
      });
      history.push(result);
      if (history.length > MAX_HISTORY) history.shift();
      return result;
    };
    const fail = (code: ToolError['code'], message: string, extra: Partial<ToolError> = {}) =>
      done({ error: { code, message, retryable: false, ...extra } });

    if (!tool) return fail('unknown-tool', `Outil inconnu : ${id}`);
    if (hash === null)
      return fail(
        'invalid-input',
        size > MAX_INPUT_BYTES && size !== Infinity
          ? `Entrée trop volumineuse (${size} > ${MAX_INPUT_BYTES} octets)`
          : 'Entrée refusée : JSON simple et peu profond attendu'
      );
    let parsed: ReturnType<z.ZodType['safeParse']>;
    try {
      parsed = tool.input.safeParse(rawInput);
    } catch {
      return fail('invalid-input', 'Entrée refusée par le schéma de l’outil');
    }
    if (!parsed.success)
      return fail('invalid-input', 'Entrée refusée par le schéma de l’outil', {
        ...(parsed.success ? {} : { details: z.treeifyError(parsed.error) as z.core.util.JSONType })
      });
    // Runtime check too: the future loop builds grants from data, not from TypeScript.
    const grants = permissionClassSchema.array().safeParse(options.grants);
    if (!grants.success)
      return fail('permission-denied', 'Permissions accordées illisibles', {
        details: { grants: 'invalides' }
      });
    const missing = tool.meta.permissions.filter((p) => !grants.data.includes(p));
    if (missing.length)
      return fail('permission-denied', `Permission non accordée : ${missing.join(', ')}`, {
        details: { missing }
      });
    const unmet = missingRequirements(tool.meta.requires);
    const availability = unmet.length
      ? {
          ok: false,
          reason: `prérequis absent : ${unmet.join(', ')}`,
          installHint: `Installer ${unmet.join(', ')} (voir docs/RUNBOOK.md)`
        }
      : await tool.available(ctx);
    if (!availability.ok)
      return fail(
        'unavailable',
        `Outil indisponible : ${availability.reason ?? 'raison inconnue'}`,
        {
          ...(availability.installHint ? { installHint: availability.installHint } : {})
        }
      );

    if (options.signal?.aborted) return fail('cancelled', 'Appel annulé avant exécution');
    const callId = newId('tcl');
    const controller = new AbortController();
    const { limits } = tool.meta;
    const call: CallContext = {
      ...ctx,
      revision(revisionId) {
        const revision = ctx.repo.getRevision(revisionId);
        if (revision?.projectId !== ctx.projectId)
          throw new ToolDenied('Révision hors du projet de ce registre');
        return revision;
      },
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
      },
      signal: controller.signal,
      processLimits: {
        cpuSeconds: limits.cpuSeconds ?? MEDIA_LIMITS.cpuSeconds,
        fileSizeBytes: MEDIA_LIMITS.fileSizeBytes,
        addressSpaceBytes: limits.memoryBytes ?? MEDIA_LIMITS.addressSpaceBytes
      }
    };
    let timer: NodeJS.Timeout | undefined;
    let output: unknown;
    const onAbort = () => controller.abort(new ToolCancelled());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // Timeout and caller abort both abort `call.signal`: a tool that passes it to
      // runProcess has its process group killed; the call itself ends at once either way.
      output = await Promise.race([
        tool.run(parsed.data, call),
        new Promise((_, reject) => {
          timer = setTimeout(() => controller.abort(new ToolTimeout()), limits.timeoutMs);
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true
          });
        })
      ]);
    } catch (error) {
      if (error instanceof ToolCancelled) return fail('cancelled', 'Appel annulé par la boucle');
      if (error instanceof ToolDenied) return fail('permission-denied', error.message);
      if (error instanceof ToolFailure)
        return fail(error.code, safeMessage(error, ctx.storage.root));
      // The call ends but its work may go on (no AbortSignal yet): only a side-effect-free
      // tool may be retried; others must be observed before any new attempt.
      if (error instanceof ToolTimeout)
        return fail(
          'timeout',
          `Délai dépassé (${tool.meta.limits.timeoutMs} ms)` +
            (tool.meta.sideEffects === 'none' ? '' : ' ; l’opération peut se poursuivre'),
          { retryable: tool.meta.sideEffects === 'none' }
        );
      return fail('failed', `Échec de l’outil : ${safeMessage(error, ctx.storage.root)}`);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
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

  return { list, invoke, history, meta };
}
export type ToolRegistry = ReturnType<typeof createToolRegistry>;
