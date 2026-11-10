import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export class ConfigError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "ConfigError";
  }
}
export class ConfigConflictError extends ConfigError {
  constructor(
    file: string,
    public readonly path: string,
    public readonly lockedBy: string,
  ) {
    super(file, `locked path "${path}" conflicts with ${lockedBy}`);
    this.name = "ConfigConflictError";
  }
}
type ObjectValue = Record<string, unknown>;
type Parser = (source: string) => unknown;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function safe(value: unknown): void {
  if (Array.isArray(value)) value.forEach(safe);
  else if (object(value))
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw new Error("Unsafe configuration key");
      safe(child);
    }
}
function merge(base: ObjectValue, next: ObjectValue): ObjectValue {
  const result = { ...base };
  for (const [key, value] of Object.entries(next)) {
    result[key] =
      object(result[key]) && object(value) ? merge(result[key], value) : value;
  }
  return result;
}
function at(value: ObjectValue, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) => (object(current) ? current[key] : undefined),
      value,
    );
}
function markdown(source: string): unknown {
  const match =
    /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) throw new Error("Expected YAML frontmatter");
  const metadata: unknown = parseYaml(match[1]);
  if (!object(metadata)) throw new Error("Expected frontmatter object");
  return { ...metadata, instructions: match[2].trim() };
}
export interface ConfigLayer {
  file: string;
  source?: string;
}
export interface LoadedConfig<T> {
  value: T;
  redacted(): T;
}
export class ConfigLoader<T> {
  private parsers = new Map<string, Parser>([
    [".json", JSON.parse],
    [".yaml", parseYaml],
    [".yml", parseYaml],
    [".md", markdown],
  ]);
  constructor(
    private schema: z.ZodType<T>,
    private options: {
      schemaVersion?: number;
      defaults?: ObjectValue;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {}
  registerParser(extension: string, parser: Parser): this {
    this.parsers.set(extension.toLowerCase(), parser);
    return this;
  }
  // Layers must be supplied in global, template, project order.
  load(layers: ConfigLayer[]): LoadedConfig<T> {
    let merged = structuredClone(this.options.defaults ?? {});
    safe(merged);
    const locks = new Map<string, { file: string; value: unknown }>();
    const origins = new Map<string, string>();
    for (const layer of layers) {
      const parser = this.parsers.get(extname(layer.file).toLowerCase());
      if (!parser) throw new ConfigError(layer.file, "Unsupported format");
      let raw: unknown;
      try {
        raw = parser(layer.source ?? readFileSync(layer.file, "utf8"));
        safe(raw);
      } catch {
        throw new ConfigError(
          layer.file,
          "Unable to read or parse configuration",
        );
      }
      if (!object(raw))
        throw new ConfigError(layer.file, "Expected configuration object");
      if (raw.schemaVersion !== (this.options.schemaVersion ?? 1))
        throw new ConfigError(layer.file, "Unsupported schemaVersion");
      const declared = raw.locked ?? [];
      if (
        !Array.isArray(declared) ||
        declared.some(
          (path) =>
            typeof path !== "string" || !/^[\w-]+(?:\.[\w-]+)*$/.test(path),
        )
      )
        throw new ConfigError(layer.file, "Invalid locked paths");
      const { locked: _locked, ...data } = raw;
      const next = merge(merged, data);
      for (const [path, lock] of locks)
        if (!isDeepStrictEqual(at(next, path), lock.value))
          throw new ConfigConflictError(layer.file, path, lock.file);
      merged = next;
      for (const path of declared as string[]) {
        const value = at(merged, path);
        if (value === undefined)
          throw new ConfigError(
            layer.file,
            `Locked path "${path}" does not exist`,
          );
        if (!locks.has(path))
          locks.set(path, { file: layer.file, value: structuredClone(value) });
      }
      const mark = (value: unknown, path: string): void => {
        origins.set(path, layer.file);
        if (object(value) || Array.isArray(value))
          for (const [key, child] of Object.entries(value))
            mark(child, path ? `${path}.${key}` : key);
      };
      mark(data, "");
    }
    const file = layers.at(-1)?.file ?? "<defaults>";
    const secrets = new Set<string>();
    const secretPaths = new Set<string>();
    const resolve = (value: unknown, path: string): unknown => {
      if (typeof value === "string" && value.startsWith("env:")) {
        const variable = value.slice(4);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))
          throw new ConfigError(
            origins.get(path) ?? file,
            `Invalid environment reference at ${path}`,
          );
        const secret = (this.options.env ?? process.env)[variable];
        if (secret === undefined)
          throw new ConfigError(
            origins.get(path) ?? file,
            `Missing environment variable ${variable}`,
          );
        secrets.add(secret);
        secretPaths.add(path);
        return secret;
      }
      if (Array.isArray(value))
        return value.map((child, i) => resolve(child, `${path}.${i}`));
      if (object(value))
        return Object.fromEntries(
          Object.entries(value).map(([key, child]) => [
            key,
            resolve(child, path ? `${path}.${key}` : key),
          ]),
        );
      return value;
    };
    const result = this.schema.safeParse(resolve(merged, ""));
    if (!result.success)
      throw new ConfigError(
        file,
        `Validation failed at ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
      );
    const redact = (value: unknown, path: string): unknown => {
      if (secretPaths.has(path)) return "[REDACTED]";
      if (typeof value === "string") {
        let text = value;
        for (const secret of secrets)
          if (secret) text = text.split(secret).join("[REDACTED]");
        return text;
      }
      if (Array.isArray(value))
        return value.map((child, i) => redact(child, `${path}.${i}`));
      if (object(value))
        return Object.fromEntries(
          Object.entries(value).map(([key, child]) => [
            key,
            redact(child, path ? `${path}.${key}` : key),
          ]),
        );
      return value;
    };
    const snapshot = structuredClone(result.data);
    return { value: result.data, redacted: () => redact(snapshot, "") as T };
  }
}

const version = { schemaVersion: z.literal(1) };
export const configSchemas = {
  audio: z.object({
    ...version,
    allowedFormats: z
      .array(
        z.enum([
          "wav",
          "mp3",
          "flac",
          "ogg",
          "mov",
          "mp4",
          "m4a",
          "3gp",
          "3g2",
          "mj2",
          "aiff",
        ]),
      )
      .min(1),
    maxFileBytes: z.number().int().positive(),
    maxDurationSeconds: z.number().positive(),
    mix: z.object({
      sampleRate: z.literal(48000),
      channels: z.literal(2),
      codec: z.literal("aac"),
      bitrateKbps: z.number().int().min(8).max(512),
      truePeakDb: z.number().min(-24).max(0),
      targetLufs: z.number().min(-30).max(-5),
    }),
    qa: z.object({
      silenceNoiseDb: z.number().min(-120).max(0).default(-50),
      silenceMinMs: z.number().positive().default(500),
      clippingPeakDb: z.number().max(0).default(-0.1),
      loudnessToleranceLu: z.number().nonnegative().default(3),
      syncToleranceMs: z.number().nonnegative().default(40),
      durationToleranceMs: z.number().nonnegative().default(100),
    }),
    cpuSeconds: z.number().int().positive().max(600),
    timeoutMs: z.number().int().positive().max(600000),
  }),
  app: z.object({
    ...version,
    name: z.string(),
    projectsRoot: z.string().min(1).default("projects"),
    maxDurationSeconds: z.number().positive().max(60),
    review: z
      .object({
        maxCommentLength: z.number().int().positive().max(5000).default(2000),
        maxBatchSize: z.number().int().positive().max(100).default(20),
      })
      .default({ maxCommentLength: 2000, maxBatchSize: 20 }),
  }),
  engines: z.object({
    ...version,
    hyperframes: z.object({
      cliVersion: z.literal("0.8.214"),
      quality: z.enum(["draft", "looks", "delivery"]),
      allowUnsandboxed: z.boolean().default(false),
      wallTimeoutMs: z.number().int().positive().default(120000),
      cpuSeconds: z.number().int().positive().default(90),
      maxOutputBytes: z.number().int().positive().default(104857600),
      fps: z.number().positive(),
    }),
  }),
  formats: z.object({
    ...version,
    maxDurationSeconds: z.number().positive().max(60),
    formats: z.record(
      z.string(),
      z.object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
    ),
  }),
  models: z.object({
    ...version,
    // Initial provider when neither /settings nor VEYRA_AI_PROVIDER chose one; null = none.
    defaultProvider: z
      .enum([
        "fake",
        "anthropic-api",
        "claude-subscribe",
        "openai-api",
        "codex-chatgpt",
      ])
      .nullable()
      .default(null),
    models: z.array(z.string()).min(1),
    // Local price list (D022): a model without an entry is refused before any call.
    pricing: z
      .record(
        z.string(),
        z.object({
          inputUsdPerMTok: z.number().positive(),
          outputUsdPerMTok: z.number().positive(),
          source: z.string().min(1),
          checkedAt: z.iso.date(),
        }),
      )
      .default({}),
    // Output ceiling sent with, and reserved for, every billable call.
    maxTokens: z.number().int().positive().max(128000).default(16000),
    callTimeoutMs: z.number().int().positive().max(600000).default(120000),
    // Ceiling of one production's spend envelope (D022): the UI and raiseBudget refuse above it.
    maxBudgetUsd: z.number().positive().max(1000).default(20),
    // API endpoints (HTTPS only), set here and never from ANTHROPIC_BASE_URL/OPENAI_BASE_URL.
    baseUrls: z
      .object({
        anthropic: z
          .url({ protocol: /^https$/ })
          .default("https://api.anthropic.com"),
        openai: z
          .url({ protocol: /^https$/ })
          .default("https://api.openai.com/v1"),
      })
      .default({
        anthropic: "https://api.anthropic.com",
        openai: "https://api.openai.com/v1",
      }),
    // Name of the variable holding the key: the secret itself never enters config.
    apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    // openai-api (T140): no model by default; it also needs a sourced entry in `pricing`.
    openai: z
      .object({ model: z.string().min(1).nullable().default(null) })
      .default({ model: null }),
    // codex-chatgpt (D023): user-installed binary, absolute paths only; enabled in /settings.
    codexChatgpt: z
      .object({
        command: z.string().regex(/^\//).nullable().default(null),
        codexHome: z.string().regex(/^\//).nullable().default(null),
        timeoutMs: z.number().int().positive().max(600000).default(300000),
      })
      .default({ command: null, codexHome: null, timeoutMs: 300000 }),
    // Assisted only: Veyra exports requests, the user runs Claude Code, Veyra imports results.
    claudeSubscribe: z.object({
      mode: z.literal("assisted"),
      command: z.string().regex(/^[A-Za-z0-9_./-]+$/),
    }),
    fake: z.object({
      provider: z.literal("fake"),
      usage: z.literal("test-only"),
    }),
  }),
  quality: z.object({
    ...version,
    durationToleranceMs: z.number().nonnegative(),
    minResolution: z.object({
      width: z.number().positive(),
      height: z.number().positive(),
    }),
    maxAutoFixAttempts: z.literal(2),
    // Below this PSNR, two frames of the previous and new render are considered different.
    correctionCheck: z
      .object({ psnrThresholdDb: z.number().positive().default(40) })
      .default({ psnrThresholdDb: 40 }),
    // Language of the expert QA texts (justifications, observations).
    reportLanguage: z.enum(["fr", "en"]).default("fr"),
  }),
  // Optional local engines (T116): pinned artefacts, installed only by `pnpm voice:install`.
  voice: z.object({
    ...version,
    // Base directory; each engine lives in <enginesRoot>/<id>. VEYRA_ENGINES_ROOT overrides it.
    enginesRoot: z.string().min(1).default("~/.local/share/veyra/engines"),
    engines: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z][a-z0-9-]*$/),
          kind: z.enum(["tts", "asr", "alignment"]),
          status: z.enum(["candidate", "adopted"]),
          version: z.string().min(1),
          artefacts: z
            .array(
              z.object({
                // Stored as <engine root>/<name>; no path separators, no leading dot.
                name: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/),
                // null = not pinned yet: installation refused until it is filled in.
                url: z.url({ protocol: /^https$/ }).nullable(),
                sizeBytes: z.number().int().positive().nullable(),
                // null = unknown: refused unless accepted explicitly (trust on first use).
                sha256: z
                  .string()
                  .regex(/^[0-9a-f]{64}$/)
                  .nullable(),
                // Python wheel: PyPI identity, installed offline from the verified file.
                pypi: z
                  .object({
                    project: z.string().min(1),
                    version: z.string().min(1),
                  })
                  .optional(),
                licence: z.string().min(1),
                attribution: z.string().nullable().default(null),
                redistribution: z.string().min(1),
                note: z.string().optional(),
              }),
            )
            .min(1),
        }),
      )
      .default([]),
  }),
  style: z.object({
    ...version,
    palette: z.record(z.string(), z.string()),
    fonts: z.array(z.string()),
    instructions: z.string().min(1),
  }),
};
