import { readFileSync } from "node:fs";
import { z } from "zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { BilledUsage } from "@veyra/schemas";
import { settleSafely, type AnthropicLimits, type CallOptions } from "./index";
import { StructuredProvider, type AskImage } from "./structured";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Same rules as anthropicClient: explicit key and endpoint (never process.env), no SDK retry. */
export const openaiClient = (
  apiKey: string,
  baseURL: string = OPENAI_BASE_URL,
) => new OpenAI({ apiKey, baseURL, maxRetries: 0 });

/** SDK failures as plain messages: status class only, never request or response content. */
export function openAiErrorMessage(error: unknown): string {
  if (error instanceof OpenAI.APIUserAbortError)
    return "Appel IA annulé (production arrêtée)";
  if (error instanceof OpenAI.APIConnectionTimeoutError)
    return "Délai dépassé pour l'appel à l'API OpenAI";
  if (error instanceof OpenAI.APIConnectionError)
    return "Connexion à l'API OpenAI impossible";
  if (error instanceof OpenAI.RateLimitError)
    return "API OpenAI : limite de débit atteinte (429), réessayer plus tard";
  if (error instanceof OpenAI.AuthenticationError)
    return "API OpenAI : clé refusée (401)";
  if (error instanceof OpenAI.APIError)
    return `API OpenAI : erreur ${error.status ?? "inconnue"}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tokens added around the counted bytes (role and message framing). Byte-level BPE
 * never yields more tokens than UTF-8 bytes; the framing is not documented, hence a margin.
 */
export const OPENAI_FRAMING_TOKENS = 256;

/** Strict Zod format when the SDK helper accepts the schema, else a plain JSON Schema. */
function textFormat(schema: z.ZodType, name: string) {
  try {
    return zodTextFormat(schema, name);
  } catch {
    // Strict mode rejects `.optional()` without `.nullable()` and open unions (storyboard,
    // plan): non-strict schema there, and the answer is revalidated by Zod either way.
    return {
      type: "json_schema" as const,
      name,
      schema: z.toJSONSchema(schema) as Record<string, unknown>,
      strict: false,
    };
  }
}

/** Real provider through the Responses API. Unverified: never called with a real key. */
export class OpenAiProvider extends StructuredProvider {
  readonly kind = "openai-api" as const;
  constructor(
    readonly model: string,
    private readonly client: OpenAI,
    private readonly limits: AnthropicLimits = {
      maxTokens: 16000,
      timeoutMs: 120000,
    },
    /** Sourced upper bound of one image in tokens; undefined = images refused. */
    private readonly imageTokens?: number,
  ) {
    super();
  }
  async ask<T extends z.ZodType>(
    schema: T,
    system: string,
    text: string,
    images: AskImage[],
    call?: CallOptions,
  ): Promise<z.infer<T>> {
    const meter = call?.meter;
    if (!meter)
      throw new Error("Appel facturable refusé : aucune enveloppe budgétaire");
    if (images.length && this.imageTokens === undefined)
      throw new Error(
        "openai-api : images refusées, aucune borne de jetons d'image sourcée (T140)",
      );
    const format = textFormat(schema, "veyra_output");
    const content: OpenAI.Responses.ResponseInputContent[] = [
      { type: "input_text", text },
    ];
    for (const image of images)
      content.push(
        { type: "input_text", text: image.label },
        {
          type: "input_image",
          detail: "auto",
          image_url: `data:image/png;base64,${readFileSync(image.path).toString("base64")}`,
        },
      );
    // Offline upper bound: one token per UTF-8 byte of everything textual sent.
    const inputTokens =
      Buffer.byteLength(system) +
      Buffer.byteLength(JSON.stringify(format)) +
      Buffer.byteLength(text) +
      images.reduce(
        (sum, image) =>
          sum + Buffer.byteLength(image.label) + (this.imageTokens ?? 0),
        0,
      ) +
      OPENAI_FRAMING_TOKENS;
    meter.before({
      model: this.model,
      inputTokens,
      maxTokens: this.limits.maxTokens,
    });
    let usage: { model: string; usage: BilledUsage } | null = null;
    try {
      const response = await this.client.responses.create(
        {
          model: this.model,
          instructions: system,
          input: [{ role: "user", content }],
          text: { format },
          max_output_tokens: this.limits.maxTokens,
          store: false,
        },
        { signal: call.signal, timeout: this.limits.timeoutMs },
      );
      if (response.usage)
        usage = {
          model: response.model,
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          },
        };
      const refused = response.output.some(
        (item) =>
          item.type === "message" &&
          item.content.some((part) => part.type === "refusal"),
      );
      if (refused) throw new Error("Le modèle a refusé la demande");
      if (response.status !== "completed")
        throw new Error(
          `API OpenAI : réponse ${response.status ?? "inconnue"}${response.incomplete_details?.reason ? ` (${response.incomplete_details.reason})` : ""}`,
        );
      return schema.parse(JSON.parse(response.output_text));
    } catch (error) {
      if (error instanceof OpenAI.OpenAIError)
        throw new Error(openAiErrorMessage(error), { cause: error });
      throw error;
    } finally {
      settleSafely(meter, usage);
    }
  }
}
