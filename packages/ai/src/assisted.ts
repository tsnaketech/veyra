import { execFile } from "node:child_process";
import { z } from "zod";
import type { AudioComposition, Storyboard } from "@veyra/schemas";
import {
  instructions,
  planInput,
  revisionProposalSchema,
  storyboardDraftSchema,
  type FeedbackInput,
} from "./index";
import {
  evaluationInstructions,
  expertReviewSchema,
  publicEvaluationInput,
  type EvaluationInput,
} from "./evaluation";

export const assistedTaskFormat = "veyra-ai-task/v1";
// Lazy: index.ts imports this module, so its schemas are not initialised yet at load time.
const outputs = () => ({
  storyboard: storyboardDraftSchema,
  plan: revisionProposalSchema,
  evaluation: expertReviewSchema,
});
type Outputs = ReturnType<typeof outputs>;
export type AssistedKind = keyof Outputs;

/**
 * claude-subscribe: Veyra never calls Claude. It writes a self-contained request
 * that the user processes with their own Claude Code session, then validates the
 * result file it gets back (see .agents/skills/veyra-assisted-task).
 */
export class AssistedProvider {
  readonly kind = "claude-subscribe" as const;
  readonly mode = "assisted" as const;

  storyboardRequest(
    prompt: string,
    options: { targetDurationMs: number; styleInstructions: string },
  ) {
    return this.request("storyboard", instructions.storyboard(options), {
      prompt,
      targetDurationMs: options.targetDurationMs,
    });
  }
  /** Images are referenced by file name; the caller copies them next to request.json. */
  planRequest(
    storyboard: Storyboard,
    feedback: FeedbackInput[],
    audio: AudioComposition | null = null,
  ) {
    return this.request("plan", instructions.plan, {
      ...planInput(storyboard, feedback, audio),
      images: feedback
        .filter((item) => item.capturePath)
        .map((item) => ({
          feedbackId: item.id,
          file: `frames/${item.id}.png`,
        })),
    });
  }
  /** Images are referenced as images/<file>; the caller copies them next to request.json. */
  evaluationRequest(input: EvaluationInput) {
    const data = publicEvaluationInput(input);
    return this.request("evaluation", evaluationInstructions(input.language), {
      ...data,
      images: data.images.map((image) => ({
        ...image,
        path: `images/${image.file}`,
      })),
    });
  }
  parseResult<K extends AssistedKind>(
    kind: K,
    raw: unknown,
  ): z.infer<Outputs[K]> {
    return outputs()[kind].parse(raw) as z.infer<Outputs[K]>;
  }
  private request(
    kind: AssistedKind,
    text: string,
    input: Record<string, unknown>,
  ) {
    return {
      format: assistedTaskFormat,
      kind,
      instructions: text,
      input,
      outputSchema: z.toJSONSchema(outputs()[kind]),
      resultFile: "result.json",
    };
  }
}

export interface ClaudeSubscribeStatus {
  available: boolean;
  reason: string;
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  /** Claude Code prefers an API key over the subscription when one is in its environment. */
  apiKeyInEnvironment: boolean;
}
export type RunCommand = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string }>;
const run: RunCommand = (command, args, env) =>
  new Promise((resolve, reject) =>
    execFile(
      command,
      args,
      { env, timeout: 5000, shell: false },
      (error, stdout) => (error ? reject(error) : resolve({ stdout })),
    ),
  );
const apiCredentialVars = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/**
 * Local, read-only check through Claude Code's own commands. No credential file is
 * read; only loggedIn / authMethod / subscriptionType are kept (never email or org).
 */
export async function checkClaudeSubscribe(
  options: {
    command?: string;
    env?: NodeJS.ProcessEnv;
    runner?: RunCommand;
  } = {},
): Promise<ClaudeSubscribeStatus> {
  const command = options.command ?? "claude";
  const env = options.env ?? process.env;
  const runner = options.runner ?? run;
  const apiKeyInEnvironment = apiCredentialVars.some((name) =>
    Boolean(env[name]),
  );
  const status: ClaudeSubscribeStatus = {
    available: false,
    reason: "",
    installed: false,
    version: null,
    loggedIn: false,
    authMethod: null,
    subscriptionType: null,
    apiKeyInEnvironment,
  };
  // Without API credentials, the status reflects the subscription login itself.
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => !apiCredentialVars.includes(name)),
  );
  try {
    status.version = (await runner(command, ["--version"], cleanEnv)).stdout
      .trim()
      .slice(0, 80);
    status.installed = true;
  } catch {
    return {
      ...status,
      reason: `Claude Code introuvable (commande « ${command} »).`,
    };
  }
  try {
    const raw = JSON.parse(
      (await runner(command, ["auth", "status", "--json"], cleanEnv)).stdout,
    );
    const auth = z
      .object({
        loggedIn: z.boolean(),
        authMethod: z.string().nullish(),
        subscriptionType: z.string().nullish(),
      })
      .parse(raw);
    status.loggedIn = auth.loggedIn;
    status.authMethod = auth.authMethod ?? null;
    status.subscriptionType = auth.subscriptionType ?? null;
  } catch {
    return { ...status, reason: "État de connexion de Claude Code illisible." };
  }
  if (!status.loggedIn)
    return {
      ...status,
      reason: "Claude Code n'est pas connecté : lancer `claude auth login`.",
    };
  if (status.authMethod !== "claude.ai")
    return {
      ...status,
      reason: `Claude Code est connecté par « ${status.authMethod ?? "inconnu"} », pas par un abonnement Claude.`,
    };
  return {
    ...status,
    available: true,
    reason: "Claude Code connecté avec un abonnement Claude.",
  };
}
