import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCK_FILE,
  doctorReport,
  engineRoot,
  engineStatus,
  findEngine,
  installEngine,
  loadVoiceConfig,
  planInstall,
  type EngineConfig,
  type Fetcher,
  type VoiceConfig,
} from "./engines";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const model = Buffer.from("model bytes");
const card = Buffer.from("model card");
const wheel = Buffer.from("wheel bytes");
const engine: EngineConfig = {
  id: "demo",
  kind: "tts",
  status: "candidate",
  version: "1.0.0",
  artefacts: [
    {
      name: "voice.onnx",
      url: "https://example.invalid/voice.onnx",
      sizeBytes: model.length,
      sha256: sha(model),
      licence: "CC-BY-4.0",
      attribution: "Credit the dataset",
      redistribution: "with attribution",
    },
    {
      name: "MODEL_CARD",
      url: "https://example.invalid/MODEL_CARD",
      sizeBytes: card.length,
      sha256: null,
      licence: "same",
      attribution: null,
      redistribution: "same",
    },
    {
      name: "demo-1.0.0-py3-none-any.whl",
      url: "https://example.invalid/demo.whl",
      sizeBytes: wheel.length,
      sha256: sha(wheel),
      pypi: { project: "demo", version: "1.0.0" },
      licence: "MIT",
      attribution: null,
      redistribution: "notice",
    },
  ],
};
const bytes: Record<string, Buffer> = {
  "https://example.invalid/voice.onnx": model,
  "https://example.invalid/MODEL_CARD": card,
  "https://example.invalid/demo.whl": wheel,
};
// Injected fetcher: local bytes only, never the network.
const fetcher = vi.fn<Fetcher>(async (url) => [bytes[url]]);
let base: string, root: string;
const log = vi.fn();
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "veyra-engines-"));
  root = join(base, "demo");
  fetcher.mockClear();
  log.mockClear();
});
afterEach(() => rmSync(base, { recursive: true, force: true }));
const install = (confirmed: boolean, acceptUnpinned = ["MODEL_CARD"]) =>
  installEngine(engine, root, {
    confirm: async () => confirmed,
    log,
    fetcher,
    acceptUnpinned,
  });

describe("repository config", () => {
  it("loads config/voice.yaml with Piper as a candidate, nothing invented", () => {
    const config = loadVoiceConfig();
    const piper = findEngine(config, "piper");
    expect(piper.status).toBe("candidate");
    const byName = Object.fromEntries(piper.artefacts.map((a) => [a.name, a]));
    expect(byName["fr_FR-mls-medium.onnx"].sha256).toBe(
      "0ed223f78466917f2bae05ee90096ce69ab1fdeb251f55590d0e7422d234e162",
    );
    // Unknown wheel URLs stay null: the installer refuses them.
    expect(piper.artefacts.filter((a) => a.pypi).map((a) => a.url)).toEqual([
      null,
      null,
      null,
    ]);
    expect(planInstall(piper, "/x").blocked.length).toBeGreaterThan(0);
  });
  it("resolves the root from VEYRA_ENGINES_ROOT and refuses the repository", () => {
    const config = {
      enginesRoot: "~/.local/share/veyra/engines",
    } as VoiceConfig;
    expect(engineRoot(config, "piper", { VEYRA_ENGINES_ROOT: base })).toBe(
      join(base, "piper"),
    );
    expect(engineRoot(config, "piper", {})).toMatch(
      /\.local\/share\/veyra\/engines\/piper$/,
    );
    expect(() =>
      engineRoot(config, "piper", { VEYRA_ENGINES_ROOT: process.cwd() }),
    ).toThrow("dans le dépôt");
  });
});

describe("engineStatus", () => {
  it("reports each state offline", async () => {
    expect(engineStatus(engine, root).state).toBe("non installé");
    mkdirSync(root);
    writeFileSync(join(root, "voice.onnx"), model);
    expect(engineStatus(engine, root)).toEqual({
      state: "incomplet",
      details: [
        "manquant : MODEL_CARD",
        "manquant : demo-1.0.0-py3-none-any.whl",
      ],
    });
    writeFileSync(join(root, "MODEL_CARD"), card);
    writeFileSync(join(root, "demo-1.0.0-py3-none-any.whl"), wheel);
    // Unpinned and absent from the lock: not verifiable.
    expect(engineStatus(engine, root).details).toEqual([
      "empreinte inconnue : MODEL_CARD",
    ]);
    rmSync(root, { recursive: true });
    await install(true);
    expect(engineStatus(engine, root).state).toBe(
      "installé, empreintes vérifiées",
    );
    writeFileSync(join(root, "voice.onnx"), Buffer.from("model bytez"));
    expect(engineStatus(engine, root)).toEqual({
      state: "installé, empreinte invalide",
      details: ["empreinte invalide : voice.onnx"],
    });
  });
  it("doctor prints state, root, licences and the install command", () => {
    const report = doctorReport(
      { schemaVersion: 1, enginesRoot: base, engines: [engine] },
      {},
    );
    expect(report).toContain("demo 1.0.0 (tts, candidat) : non installé");
    expect(report).toContain(`racine : ${root}`);
    expect(report).toContain("attribution : Credit the dataset");
    expect(report).toContain("pnpm voice:install demo (autorisation requise)");
  });
});

describe("installEngine", () => {
  it("prints the plan and does nothing without confirmation", async () => {
    expect(await install(false)).toBe("cancelled");
    const plan = log.mock.calls[0][0] as string;
    expect(plan).toContain(`Destination : ${root}`);
    expect(plan).toContain(`sha256 : ${sha(model)}`);
    expect(plan).toContain("licence : CC-BY-4.0");
    expect(plan).toContain(
      `Taille totale : ${model.length + card.length + wheel.length} octets`,
    );
    expect(plan).toContain("--require-hashes");
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(false);
  });
  it("refuses an unpinned artefact unless accepted, before asking", async () => {
    const confirm = vi.fn(async () => true);
    expect(await installEngine(engine, root, { confirm, log, fetcher })).toBe(
      "blocked",
    );
    expect(log.mock.calls[0][0]).toContain(
      "MODEL_CARD : empreinte inconnue ; refusé sans --accept-unpinned MODEL_CARD",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(false);
  });
  it("installs after confirmation and records a lock and requirements", async () => {
    expect(await install(true)).toBe("installed");
    expect(readFileSync(join(root, "voice.onnx"))).toEqual(model);
    const lock = JSON.parse(readFileSync(join(root, LOCK_FILE), "utf8"));
    expect(lock.artefacts.MODEL_CARD).toMatchObject({
      sha256: sha(card),
      sizeBytes: card.length,
      source: "trust-on-first-use",
    });
    expect(lock.artefacts["voice.onnx"].source).toBe("pinned");
    expect(readFileSync(join(root, "requirements.txt"), "utf8")).toBe(
      `demo==1.0.0 --hash=sha256:${sha(wheel)}\n`,
    );
    // Re-run: everything verified in place, nothing downloaded again.
    fetcher.mockClear();
    expect(await install(true, [])).toBe("blocked");
    expect(await install(true)).toBe("installed");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("deletes the partial file on a hash or size mismatch", async () => {
    fetcher.mockImplementationOnce(async () => [Buffer.from("model bytez")]);
    await expect(install(true)).rejects.toThrow("empreinte");
    expect(readdirSync(root)).toEqual([]);
    fetcher.mockImplementationOnce(async () => [model, Buffer.from("!")]);
    await expect(install(true)).rejects.toThrow("taille supérieure");
    expect(readdirSync(root)).toEqual([]);
  });
});
