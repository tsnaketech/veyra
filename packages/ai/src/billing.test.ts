import { afterEach, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicProvider,
  createProvider,
  type CallMeter,
  type CallOptions,
} from "./index";

const draft = {
  title: "T",
  scenes: [{ text: "A", durationMs: 2000, enter: "fade", animationMs: 500 }],
};
const usage = { input_tokens: 900, output_tokens: 1200 };

/** Simulated SDK client: records every request, never touches the network. */
function fakeClient(
  parse: (
    params: unknown,
    options: unknown,
  ) => Promise<unknown> = async () => ({
    model: "claude-test",
    usage,
    stop_reason: "end_turn",
    parsed_output: draft,
  }),
) {
  const log: string[] = [];
  const client = {
    beta: {
      messages: {
        countTokens: vi.fn(async () => {
          log.push("count");
          return { input_tokens: 1000, context_management: null };
        }),
        parse: vi.fn(async (params: unknown, options: unknown) => {
          log.push("parse");
          return parse(params, options);
        }),
      },
    },
  };
  return { client: client as unknown as Anthropic, mock: client, log };
}
function meter(log: string[] = []) {
  const calls = {
    before: [] as Parameters<CallMeter["before"]>[0][],
    after: [] as Parameters<CallMeter["after"]>[0][],
  };
  const m: CallMeter = {
    before: (call) => {
      log.push("before");
      calls.before.push(call);
    },
    after: (result) => {
      log.push("after");
      calls.after.push(result);
    },
  };
  return { meter: m, calls };
}
const limits = { maxTokens: 4000, timeoutMs: 5000 };
const story = (ai: AnthropicProvider, call?: CallOptions) =>
  ai.generateStoryboard(
    "p",
    { targetDurationMs: 2000, styleInstructions: "" },
    call,
  );

afterEach(() => vi.unstubAllEnvs());

it("builds the client from the explicit key only, without SDK retries", () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "env-key-must-not-be-used");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "env-token-must-not-be-used");
  const ai = createProvider(
    "anthropic-api",
    { ANTHROPIC_API_KEY: "explicit-key" },
    "claude-test",
  ) as AnthropicProvider;
  const client = (ai as unknown as { client: Anthropic }).client;
  expect(client.apiKey).toBe("explicit-key");
  expect(client.authToken).toBeNull();
  expect(client.maxRetries).toBe(0);
  expect(ai.model).toBe("claude-test");
});

it("ignores ANTHROPIC_BASE_URL and OPENAI_BASE_URL from the environment (T145)", () => {
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://attacker.example");
  vi.stubEnv("OPENAI_BASE_URL", "https://attacker.example/v1");
  const client = (ai: unknown) =>
    (ai as { client: { baseURL: string } }).client.baseURL;
  expect(
    client(createProvider("anthropic-api", { ANTHROPIC_API_KEY: "k" }, "m")),
  ).toBe("https://api.anthropic.com");
  const more = { openaiModel: "m", priced: () => true };
  expect(
    client(
      createProvider(
        "openai-api",
        { OPENAI_API_KEY: "k" },
        "m",
        undefined,
        more,
      ),
    ),
  ).toBe("https://api.openai.com/v1");
  const baseUrls = {
    anthropic: "https://proxy.example",
    openai: "https://proxy.example/v1",
  };
  expect(
    client(
      createProvider(
        "anthropic-api",
        { ANTHROPIC_API_KEY: "k" },
        "m",
        undefined,
        {
          baseUrls,
        },
      ),
    ),
  ).toBe(baseUrls.anthropic);
});

it("keeps the original error or answer when the settlement itself fails (T145)", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const failing: CallMeter = {
    before: () => {},
    after: () => {
      throw new Error("Réservation inconnue");
    },
  };
  const ok = new AnthropicProvider("claude-test", fakeClient().client, limits);
  await expect(story(ok, { meter: failing })).resolves.toMatchObject({
    title: "T",
  });
  const refused = new AnthropicProvider(
    "claude-test",
    fakeClient(async () => ({
      model: "claude-test",
      usage,
      stop_reason: "refusal",
      parsed_output: null,
    })).client,
    limits,
  );
  await expect(story(refused, { meter: failing })).rejects.toThrow(/refusé/);
  expect(error).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(error.mock.calls)).not.toMatch(
    /Réservation inconnue|"p"/,
  );
  error.mockRestore();
});

it("refuses a billable call without a meter and sends nothing", async () => {
  const { client, mock } = fakeClient();
  const ai = new AnthropicProvider("claude-test", client, limits);
  await expect(story(ai)).rejects.toThrow(/aucune enveloppe/);
  await expect(ai.qualityEvaluator().evaluate({} as never)).rejects.toThrow();
  expect(mock.beta.messages.countTokens).not.toHaveBeenCalled();
  expect(mock.beta.messages.parse).not.toHaveBeenCalled();
});

it("counts, reserves, calls with the reserved max_tokens, then settles the billed usage", async () => {
  const { client, mock, log } = fakeClient();
  const ai = new AnthropicProvider("claude-test", client, limits);
  const { meter: m, calls } = meter(log);
  const signal = new AbortController().signal;
  expect(await story(ai, { meter: m, signal })).toEqual(draft);
  expect(log).toEqual(["count", "before", "parse", "after"]);
  expect(calls.before).toEqual([
    { model: "claude-test", inputTokens: 1000, maxTokens: 4000 },
  ]);
  expect(calls.after).toEqual([{ model: "claude-test", usage }]);
  const [countParams, countOptions] = mock.beta.messages.countTokens.mock
    .calls[0] as unknown as [Record<string, unknown>, unknown];
  const [params, options] = mock.beta.messages.parse.mock.calls[0] as [
    Record<string, unknown>,
    unknown,
  ];
  // Same model, system and messages for the count and the call; no fallback chain.
  expect(countParams.model).toBe(params.model);
  expect(countParams.system).toBe(params.system);
  expect(countParams.messages).toEqual(params.messages);
  expect(params.max_tokens).toBe(4000);
  expect(params).not.toHaveProperty("fallbacks");
  expect(params).not.toHaveProperty("betas");
  expect(options).toEqual({ signal, timeout: 5000 });
  expect(countOptions).toEqual({ signal, timeout: 5000 });
});

it("does not call the model when the reservation is refused", async () => {
  const { client, mock } = fakeClient();
  const ai = new AnthropicProvider("claude-test", client, limits);
  const after = vi.fn();
  const refusal = new Error("Budget insuffisant");
  await expect(
    story(ai, {
      meter: {
        before: () => {
          throw refusal;
        },
        after,
      },
    }),
  ).rejects.toBe(refusal);
  expect(mock.beta.messages.parse).not.toHaveBeenCalled();
  expect(after).not.toHaveBeenCalled();
});

it("translates SDK errors without their content and keeps the reservation as spent", async () => {
  const cases: [Error, RegExp][] = [
    [
      new Anthropic.RateLimitError(
        429,
        undefined,
        "secret body",
        new Headers(),
      ),
      /limite de débit/,
    ],
    [
      new Anthropic.AuthenticationError(
        401,
        undefined,
        "secret body",
        new Headers(),
      ),
      /clé refusée/,
    ],
    [new Anthropic.APIConnectionError({ message: "secret" }), /Connexion/],
    [new Anthropic.APIConnectionTimeoutError(), /Délai dépassé/],
    [new Anthropic.APIUserAbortError(), /annulé/],
    [
      new Anthropic.InternalServerError(
        500,
        undefined,
        "secret body",
        new Headers(),
      ),
      /erreur 500/,
    ],
  ];
  for (const [error, text] of cases) {
    const { client } = fakeClient(async () => {
      throw error;
    });
    const ai = new AnthropicProvider("claude-test", client, limits);
    const { meter: m, calls } = meter();
    const failure = (await story(ai, { meter: m }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure.message).toMatch(text);
    expect(failure.message).not.toMatch(/secret/);
    expect(calls.after).toEqual([null]);
  }
});

it("settles the billed usage even when the model refuses", async () => {
  const { client } = fakeClient(async () => ({
    model: "claude-test",
    usage,
    stop_reason: "refusal",
    parsed_output: null,
  }));
  const ai = new AnthropicProvider("claude-test", client, limits);
  const { meter: m, calls } = meter();
  await expect(story(ai, { meter: m })).rejects.toThrow(/refusé/);
  expect(calls.after).toEqual([{ model: "claude-test", usage }]);
});
