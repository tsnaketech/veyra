import { describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import {
  CodexExecProvider,
  OpenAiProvider,
  ProviderUnavailableError,
  checkCodexChatgpt,
  createProvider,
  providerCapabilities,
  storyboardDraftSchema,
  type CallMeter,
} from "./index";

const draft = {
  title: "Titre",
  scenes: [
    { text: "Bonjour", durationMs: 3000, enter: "fade", animationMs: 500 },
  ],
};
const style = { targetDurationMs: 3000, styleInstructions: "" };

it("never declares a prepared or simulated provider as operational (T139)", () => {
  expect(providerCapabilities.fake.status).toBe("simulated");
  for (const id of ["openai-api", "codex-chatgpt", "local"] as const)
    expect(providerCapabilities[id].status).toBe("prepared");
  expect(providerCapabilities["codex-chatgpt"].cost).toBe("subscription");
  expect(providerCapabilities["openai-api"].images).toBe(false);
});

describe("createProvider for OpenAI and Codex (no fallback, D011)", () => {
  const key = { OPENAI_API_KEY: "sk-test-dummy" };
  const priced = (model: string) => model === "m-priced";
  it.each([
    [{}, { openaiModel: "m-priced", priced }, /OPENAI_API_KEY/],
    [key, { openaiModel: null, priced }, /aucun modèle/],
    [key, { openaiModel: "m-unpriced", priced }, /aucun tarif sourcé/],
  ])("refuses openai-api when incomplete", (env, more, why) => {
    expect(() =>
      createProvider("openai-api", env, "x", undefined, more),
    ).toThrow(why);
  });
  it("builds openai-api with key, model and sourced price, without any call", () => {
    const ai = createProvider("openai-api", key, "x", undefined, {
      openaiModel: "m-priced",
      priced,
    });
    expect(ai).toMatchObject({ kind: "openai-api", model: "m-priced" });
  });
  it("keeps codex-chatgpt unavailable until enabled, with the reason", () => {
    expect(() =>
      createProvider("codex-chatgpt", { ANTHROPIC_API_KEY: "x" }, "m"),
    ).toThrow(ProviderUnavailableError);
    expect(() => createProvider("codex-chatgpt", {}, "m")).toThrow(
      /codex login/,
    );
  });
});

function meter() {
  const log = {
    before: [] as Parameters<CallMeter["before"]>[0][],
    after: [] as Parameters<CallMeter["after"]>[0][],
  };
  const m: CallMeter = {
    before: (call) => void log.before.push(call),
    after: (result) => void log.after.push(result),
  };
  return { log, m };
}
function openai(answer: () => unknown) {
  const create = vi.fn(async () => answer());
  return {
    create,
    client: { responses: { create } } as unknown as OpenAI,
  };
}
const completed = (text: string) => ({
  model: "m-1",
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
  output_text: text,
  usage: { input_tokens: 120, output_tokens: 40 },
});

describe("OpenAiProvider (simulated client, no network)", () => {
  it("reserves an upper bound before the request and settles the billed usage", async () => {
    const { client, create } = openai(() => completed(JSON.stringify(draft)));
    const { log, m } = meter();
    const signal = new AbortController().signal;
    const ai = new OpenAiProvider("m-1", client, {
      maxTokens: 900,
      timeoutMs: 5000,
    });
    const out = await ai.generateStoryboard("Une vidéo", style, {
      meter: m,
      signal,
    });
    expect(out.title).toBe("Titre");
    const [body, options] = create.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(body).toMatchObject({
      model: "m-1",
      max_output_tokens: 900,
      store: false,
    });
    expect(options).toEqual({ signal, timeout: 5000 });
    // One token per byte of instructions, schema and prompt is an upper bound.
    const bytes =
      Buffer.byteLength(String(body.instructions)) +
      Buffer.byteLength("Une vidéo");
    expect(log.before[0].inputTokens).toBeGreaterThan(bytes);
    expect(log.before[0].maxTokens).toBe(900);
    expect(log.after).toEqual([
      { model: "m-1", usage: { input_tokens: 120, output_tokens: 40 } },
    ]);
  });
  it("refuses without an envelope and refuses images without a sourced bound", async () => {
    const { client, create } = openai(() => completed("{}"));
    const ai = new OpenAiProvider("m-1", client);
    await expect(ai.generateStoryboard("x", style)).rejects.toThrow(
      /enveloppe/,
    );
    const { m, log } = meter();
    await expect(
      ai.reviewFrames(
        { width: 10, height: 10, fps: 30, scenes: [] } as never,
        [{ timestampMs: 0, path: "/nonexistent.png" }],
        { meter: m },
      ),
    ).rejects.toThrow(/images refusées/);
    expect(create).not.toHaveBeenCalled();
    expect(log.before).toEqual([]);
  });
  it("sends images as input_image and counts them with the configured bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "veyra-oai-"));
    const png = join(dir, "f.png");
    writeFileSync(png, Buffer.from("89504e47", "hex"));
    try {
      const { client, create } = openai(() =>
        completed(JSON.stringify({ findings: [] })),
      );
      const { m, log } = meter();
      const ai = new OpenAiProvider("m-1", client, undefined, 5000);
      await ai.reviewFrames(
        { width: 10, height: 10, fps: 30, scenes: [] } as never,
        [{ timestampMs: 0, path: png }],
        { meter: m },
      );
      const body = (
        create.mock.calls[0] as unknown as [
          { input: { content: { type: string }[] }[] },
        ]
      )[0];
      expect(body.input[0].content.map((part) => part.type)).toContain(
        "input_image",
      );
      expect(log.before[0].inputTokens).toBeGreaterThan(5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects output that fails Zod, settling usage anyway", async () => {
    const { client } = openai(() => completed('{"title":""}'));
    const { m, log } = meter();
    await expect(
      new OpenAiProvider("m-1", client).generateStoryboard("x", style, {
        meter: m,
      }),
    ).rejects.toThrow();
    expect(log.after).toHaveLength(1);
    expect(log.after[0]?.usage.output_tokens).toBe(40);
  });
  it("translates SDK errors without content and keeps the reservation as spent", async () => {
    const { client } = openai(() => {
      throw new OpenAI.APIConnectionTimeoutError({ message: "secret prompt" });
    });
    const { m, log } = meter();
    await expect(
      new OpenAiProvider("m-1", client).generateStoryboard("x", style, {
        meter: m,
      }),
    ).rejects.toThrow(/^Délai dépassé pour l'appel à l'API OpenAI$/);
    expect(log.after).toEqual([null]);
  });
});

describe("CodexExecProvider (fake codex binary, nothing real is launched)", () => {
  // A real executable standing in for `codex`: behaviour chosen by a file in CODEX_HOME.
  function fakeCodex(mode: "valid" | "invalid" | "sleep" | "logged-out") {
    const dir = mkdtempSync(join(tmpdir(), "veyra-codex-test-"));
    const bin = join(dir, "codex");
    writeFileSync(join(dir, "mode"), mode);
    writeFileSync(
      bin,
      `#!${process.execPath}
const fs = require("node:fs");
const home = process.env.CODEX_HOME;
const mode = fs.readFileSync(home + "/mode", "utf8");
const args = process.argv.slice(2);
fs.writeFileSync(home + "/call.json", JSON.stringify({ args, env: process.env, cwd: process.cwd(), cwdFiles: fs.readdirSync(process.cwd()) }));
fs.writeFileSync(home + "/pid", String(process.pid));
if (args[0] === "--version") { process.stdout.write("codex-cli 0.0.0-fake\\n"); process.exit(0); }
if (args[0] === "login") process.exit(mode === "logged-out" ? 1 : 0);
if (mode === "sleep") setTimeout(() => {}, 60000);
else {
  const out = args[args.indexOf("--output-last-message") + 1];
  fs.writeFileSync(out, mode === "valid" ? ${JSON.stringify(JSON.stringify(draft))} : '{"title":42}');
  process.stdout.write('{"type":"turn.completed"}\\n');
}
`,
    );
    chmodSync(bin, 0o755);
    const options = {
      command: bin,
      env: { HOME: dir, CODEX_HOME: dir },
      timeoutMs: 5000,
    };
    const call = () => JSON.parse(readFileSync(join(dir, "call.json"), "utf8"));
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    return { dir, options, call, cleanup };
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("turns valid JSON output into a storyboard draft, read-only and confined", async () => {
    const fake = fakeCodex("valid");
    try {
      const out = await new CodexExecProvider(fake.options).generateStoryboard(
        "Une vidéo",
        style,
      );
      expect(storyboardDraftSchema.parse(out).title).toBe("Titre");
      const { args, env, cwdFiles } = fake.call();
      expect(args.slice(0, 3)).toEqual(["exec", "--json", "--ephemeral"]);
      for (const flag of [
        "--ignore-user-config",
        "--ignore-rules",
        "--output-schema",
        'approval_policy="never"',
        "features.shell_tool=false",
        "tools.web_search=false",
        "features.view_image=false",
        'forced_login_method="chatgpt"',
      ])
        expect(args).toContain(flag);
      expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
      expect(cwdFiles).toEqual([]);
      expect(Object.keys(env).sort()).toEqual([
        "CODEX_HOME",
        "HOME",
        "LANG",
        "PATH",
      ]);
    } finally {
      fake.cleanup();
    }
  });
  it("rejects output that does not match the schema", async () => {
    const fake = fakeCodex("invalid");
    try {
      await expect(
        new CodexExecProvider(fake.options).generateStoryboard("x", style),
      ).rejects.toThrow(/non conforme/);
    } finally {
      fake.cleanup();
    }
  });
  it("refuses to start with OPENAI_API_KEY or CODEX_API_KEY in Codex's environment", () => {
    const fake = fakeCodex("valid");
    try {
      for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY"])
        expect(
          () =>
            new CodexExecProvider({
              ...fake.options,
              env: { ...fake.options.env, [name]: "sk-dummy" } as never,
            }),
        ).toThrow(/bascule de facturation/);
      expect(existsSync(join(fake.dir, "call.json"))).toBe(false);
    } finally {
      fake.cleanup();
    }
  });
  it("kills the process on timeout and on abort", async () => {
    const fake = fakeCodex("sleep");
    try {
      const slow = new CodexExecProvider({ ...fake.options, timeoutMs: 500 });
      await expect(slow.generateStoryboard("x", style)).rejects.toThrow(
        /délai dépassé/,
      );
      const first = Number(readFileSync(join(fake.dir, "pid"), "utf8"));
      expect(alive(first)).toBe(false);

      const controller = new AbortController();
      const pending = new CodexExecProvider(fake.options).generateStoryboard(
        "x",
        style,
        {
          signal: controller.signal,
        },
      );
      await vi.waitFor(() =>
        expect(readFileSync(join(fake.dir, "pid"), "utf8")).not.toBe(
          String(first),
        ),
      );
      controller.abort();
      await expect(pending).rejects.toThrow(/annulé/);
      expect(alive(Number(readFileSync(join(fake.dir, "pid"), "utf8")))).toBe(
        false,
      );
    } finally {
      fake.cleanup();
    }
  });
  it("probes only when enabled, and only --version and login status", async () => {
    expect(
      await checkCodexChatgpt({ enabled: false, command: null, env: {} }),
    ).toMatchObject({
      available: false,
      reason: expect.stringMatching(/ambigu/),
    });
    const out = fakeCodex("logged-out");
    try {
      const status = await checkCodexChatgpt({ enabled: true, ...out.options });
      expect(status).toMatchObject({
        available: false,
        version: "codex-cli 0.0.0-fake",
      });
      expect(status.reason).toMatch(/codex login/);
      expect(out.call().args).toEqual(["login", "status"]);
    } finally {
      out.cleanup();
    }
    const ok = fakeCodex("valid");
    try {
      expect(
        await checkCodexChatgpt({ enabled: true, ...ok.options }),
      ).toMatchObject({
        available: true,
      });
    } finally {
      ok.cleanup();
    }
  });
});
