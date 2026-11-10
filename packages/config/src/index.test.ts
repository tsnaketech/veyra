import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { ConfigLoader, ConfigConflictError, configSchemas } from "./index";
const schema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().default("Veyra"),
  nested: z.object({ value: z.number() }).optional(),
  instructions: z.string().optional(),
  apiKey: z.string().optional(),
});
const loader = () => new ConfigLoader(schema);
describe("formats", () => {
  it.each(["yaml", "yml", "json", "md"])("loads %s", (ext) => {
    const source =
      ext === "json"
        ? '{"schemaVersion":1}'
        : ext === "md"
          ? "---\nschemaVersion: 1\n---\nBrand"
          : "schemaVersion: 1";
    expect(loader().load([{ file: `test.${ext}`, source }]).value.name).toBe(
      "Veyra",
    );
  });
  it("treats Markdown code and commands as inert text", () => {
    const instructions =
      '```js\nthrow new Error("executed");\n```\n$(touch /tmp/should-not-exist)';
    expect(
      loader().load([
        {
          file: "style.md",
          source: `---\nschemaVersion: 1\n---\n${instructions}`,
        },
      ]).value.instructions,
    ).toBe(instructions);
  });
});
it("merges defaults and global, template, project layers", () => {
  const result = new ConfigLoader(schema, {
    defaults: { name: "Default" },
  }).load([
    { file: "global.yaml", source: "schemaVersion: 1\nnested: {value: 1}" },
    { file: "template.json", source: '{"schemaVersion":1,"name":"Template"}' },
    { file: "project.yml", source: "schemaVersion: 1\nnested: {value: 2}" },
  ]);
  expect(result.value).toEqual({
    schemaVersion: 1,
    name: "Template",
    nested: { value: 2 },
  });
});
it.each(["nested: {value: 2}", "nested: null"])(
  "rejects locked descendant override: %s",
  (override) => {
    const run = () =>
      loader().load([
        {
          file: "global.yaml",
          source:
            "schemaVersion: 1\nlocked: [nested.value]\nnested: {value: 1}",
        },
        { file: "project.yaml", source: `schemaVersion: 1\n${override}` },
      ]);
    expect(run).toThrow(ConfigConflictError);
    expect(run).toThrow(/project.yaml.*nested.value.*global.yaml/);
  },
);
it("allows identical locked values but not removing locks", () => {
  expect(
    loader().load([
      {
        file: "global.yaml",
        source: "schemaVersion: 1\nlocked: [name]\nname: Veyra",
      },
      {
        file: "project.yaml",
        source: "schemaVersion: 1\nlocked: []\nname: Veyra",
      },
    ]).value.name,
  ).toBe("Veyra");
});
it.each([
  ["bad.yaml", "schemaVersion: 2", "schemaVersion"],
  ["bad.json", "{", "parse"],
  ["bad.txt", "schemaVersion: 1", "format"],
  ["bad.yaml", "schemaVersion: 1\nnested: false", "Validation"],
  ["bad.yaml", "schemaVersion: 1\nlocked: [missing]", "does not exist"],
  ["bad.yaml", "schemaVersion: 1\n__proto__: {}", "parse"],
])("reports errors with file path (%s, %s)", (file, source, message) => {
  expect(() => loader().load([{ file, source }])).toThrow(file);
  expect(() => loader().load([{ file, source }])).toThrow(message);
});
it("resolves secrets and redacts an independent snapshot", () => {
  const loaded = new ConfigLoader(schema, {
    env: { TEST_KEY: "dummy-secret" },
  }).load([
    { file: "models.yaml", source: "schemaVersion: 1\napiKey: env:TEST_KEY" },
  ]);
  expect(loaded.value.apiKey).toBe("dummy-secret");
  loaded.value.name = "mutated";
  expect(loaded.redacted()).toEqual({
    schemaVersion: 1,
    name: "Veyra",
    apiKey: "[REDACTED]",
  });
});
it("does not leak secret values in validation errors", () => {
  expect(() =>
    new ConfigLoader(z.object({ apiKey: z.literal("expected") }), {
      env: { KEY: "dummy-secret" },
    }).load([
      { file: "secret.yaml", source: "schemaVersion: 1\napiKey: env:KEY" },
    ]),
  ).toThrow("secret.yaml: Validation failed at apiKey");
});
it("rejects missing environment values explicitly", () => {
  expect(() =>
    new ConfigLoader(schema, { env: {} }).load([
      { file: "models.yaml", source: "schemaVersion: 1\napiKey: env:MISSING" },
    ]),
  ).toThrow("models.yaml: Missing environment variable MISSING");
});
it("supports registered parsers", () => {
  expect(
    loader()
      .registerParser(".custom", () => ({ schemaVersion: 1 }))
      .load([{ file: "test.custom", source: "" }]).value.name,
  ).toBe("Veyra");
});
const configs = [
  ["audio", "audio.yaml"],
  ["app", "app.yaml"],
  ["engines", "engines.json"],
  ["formats", "formats.yaml"],
  ["models", "models.json"],
  ["quality", "quality.yaml"],
  ["style", "style-guide.md"],
  ["voice", "voice.yaml"],
] as const;
it.each(configs)("loads repository config %s", (key, filename) => {
  const loaded = new ConfigLoader(configSchemas[key] as z.ZodType, {
    env: { ANTHROPIC_API_KEY: "test-only-placeholder" },
  }).load([
    { file: new URL(`../../../config/${filename}`, import.meta.url).pathname },
  ]);
  expect(loaded.value).toHaveProperty("schemaVersion", 1);
  expect(JSON.stringify(loaded.redacted())).not.toContain(
    "test-only-placeholder",
  );
});

it("bounds the spend envelope and accepts only HTTPS API endpoints (T145)", () => {
  const models = JSON.parse(
    readFileSync(
      new URL("../../../config/models.json", import.meta.url),
      "utf8",
    ),
  );
  const parse = (extra: object) =>
    configSchemas.models.safeParse({ ...models, ...extra }).success;
  expect(configSchemas.models.parse(models)).toMatchObject({
    maxBudgetUsd: 20,
    baseUrls: { anthropic: "https://api.anthropic.com" },
  });
  expect(parse({ maxBudgetUsd: 0 })).toBe(false);
  expect(parse({ maxBudgetUsd: 1e6 })).toBe(false);
  expect(
    parse({
      baseUrls: { ...models.baseUrls, openai: "http://proxy.local/v1" },
    }),
  ).toBe(false);
});
