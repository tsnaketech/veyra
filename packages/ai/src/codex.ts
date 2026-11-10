import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { ProcessError, runProcess } from "@veyra/video";
import type { CallOptions } from "./index";
import { CODEX_DEFAULT_REASON } from "./capabilities";
import { StructuredProvider, type AskImage } from "./structured";

export interface CodexOptions {
  /** Absolute path of the user-installed `codex` binary (never resolved from PATH). */
  command: string;
  /** Child environment: HOME and CODEX_HOME only (runProcess allow-list). */
  env: { HOME?: string; CODEX_HOME?: string };
  timeoutMs: number;
}

// Either variable could make Codex bill the API instead of the ChatGPT plan (precedence undocumented).
const BILLING_SWITCH_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY"];
// Linux limits one argv string to 128 KiB (MAX_ARG_STRLEN); stay below it.
const MAX_PROMPT_BYTES = 120_000;

/**
 * Early, explicit refusal only. The actual protection is runProcess's childEnv: it never
 * inherits the server environment and rejects any OPENAI_* or *_KEY variable anyway.
 */
function assertSafe(options: Pick<CodexOptions, "command" | "env">) {
  if (!isAbsolute(options.command))
    throw new Error(
      "codex-chatgpt : le chemin du binaire Codex doit être absolu",
    );
  const present = BILLING_SWITCH_VARS.filter(
    (name) => name in (options.env as Record<string, unknown>),
  );
  if (present.length)
    throw new Error(
      `codex-chatgpt refusé : ${present.join(", ")} dans l'environnement de Codex (bascule de facturation possible)`,
    );
}

/** Process failures without any model or prompt content (stderr is never surfaced). */
function codexError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return new Error("Appel IA annulé (production arrêtée)");
  if (error instanceof ProcessError)
    return new Error(
      /timeout/i.test(error.message)
        ? "Codex : délai dépassé, processus arrêté"
        : `Codex a échoué (${error.message.replace(/^.*exited/, "code")})`,
    );
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * codex-chatgpt (D023): runs the user's own `codex exec` once per call, signed in with
 * their ChatGPT plan, read-only, no approvals, no shell, web or image tools, in an empty
 * temporary directory. Options follow docs/research/OPENAI-CODEX-INTEGRATIONS.md § 7.
 */
export class CodexExecProvider extends StructuredProvider {
  readonly kind = "codex-chatgpt" as const;
  constructor(private readonly options: CodexOptions) {
    super();
    assertSafe(options);
  }
  async ask<T extends z.ZodType>(
    schema: T,
    system: string,
    text: string,
    images: AskImage[],
    call?: CallOptions,
  ): Promise<z.infer<T>> {
    assertSafe(this.options);
    const prompt = [
      system,
      images.length
        ? `Images jointes, dans l'ordre : ${images.map((image) => image.label).join(" ; ")}.`
        : "",
      text,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES)
      throw new Error(
        "codex-chatgpt : demande trop longue pour la ligne de commande",
      );
    const root = mkdtempSync(join(tmpdir(), "veyra-codex-"));
    try {
      // The working directory stays empty: no AGENTS.md, no project files to read.
      const work = join(root, "work");
      mkdirSync(work);
      const schemaFile = join(root, "schema.json");
      const lastMessage = join(root, "last-message.json");
      writeFileSync(schemaFile, JSON.stringify(z.toJSONSchema(schema)));
      const args = [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--output-schema",
        schemaFile,
        "--output-last-message",
        lastMessage,
        "-c",
        'approval_policy="never"',
        "-c",
        "features.shell_tool=false",
        "-c",
        "tools.web_search=false",
        "-c",
        "features.view_image=false",
        "-c",
        'forced_login_method="chatgpt"',
        ...images.flatMap((image) => ["--image", image.path]),
        "--",
        prompt,
      ];
      try {
        await runProcess(this.options.command, args, {
          cwd: work,
          env: this.options.env,
          timeoutMs: this.options.timeoutMs,
          signal: call?.signal,
          label: "codex",
        });
      } catch (error) {
        throw codexError(error, call?.signal);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(lastMessage, "utf8"));
      } catch {
        throw new Error("Codex : réponse finale absente ou non JSON");
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success)
        throw new Error("Codex : réponse non conforme au schéma Veyra");
      return parsed.data;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

export interface CodexStatus {
  available: boolean;
  reason: string;
  version: string | null;
}
/**
 * Availability of codex-chatgpt. Nothing runs unless the user enabled the provider
 * and configured the binary; then only `codex --version` and `codex login status`
 * (exit code and whether it mentions ChatGPT: no account detail is kept, no credential
 * file is opened).
 */
export async function checkCodexChatgpt(options: {
  enabled: boolean;
  command: string | null;
  env: CodexOptions["env"];
}): Promise<CodexStatus> {
  const off = (reason: string): CodexStatus => ({
    available: false,
    reason,
    version: null,
  });
  if (!options.enabled) return off(CODEX_DEFAULT_REASON);
  const command = options.command;
  if (!command)
    return off(
      "Chemin absolu du binaire Codex non configuré (codexChatgpt.command).",
    );
  try {
    assertSafe({ command, env: options.env });
  } catch (error) {
    return off((error as Error).message);
  }
  const probe = (args: string[]) =>
    runProcess(command, args, {
      env: options.env,
      timeoutMs: 5000,
      maxLogBytes: 65536,
      label: "codex",
    });
  let version: string;
  try {
    version = (await probe(["--version"])).stdout
      .trim()
      .split("\n")[0]
      .slice(0, 80);
  } catch {
    return off(`Codex introuvable ou inutilisable (${command}).`);
  }
  let chatgpt: boolean;
  try {
    const { stdout, stderr } = await probe(["login", "status"]);
    // Only this boolean is kept, never the output (it may name the account or a key).
    chatgpt = /chatgpt/i.test(`${stdout}\n${stderr}`);
  } catch {
    return {
      ...off("Codex n'est pas connecté : lancer `codex login`."),
      version,
    };
  }
  // An API-key login would be signed out by forced_login_method: never use it.
  if (!chatgpt) return { ...off("Connexion ChatGPT non confirmée."), version };
  return {
    available: true,
    reason:
      "Codex installé et connecté ; la méthode ChatGPT est imposée à chaque appel (forced_login_method).",
    version,
  };
}
