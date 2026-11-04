import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ConfigLoader, configSchemas } from "@veyra/config";
import type { z } from "zod";

export type VoiceConfig = z.infer<typeof configSchemas.voice>;
export type EngineConfig = VoiceConfig["engines"][number];
export type Artefact = EngineConfig["artefacts"][number];
export type EngineState =
  | "non installé"
  | "incomplet"
  | "installé, empreinte invalide"
  | "installé, empreintes vérifiées";
type Fs = Pick<typeof nodeFs, "existsSync" | "statSync" | "readFileSync">;

export const LOCK_FILE = "veyra-engine.lock.json";

/** Repository root, found like the Studio's defaultConfigDir (works from a build too). */
export function repoRoot(): string {
  let current = process.cwd();
  while (!(
    nodeFs.existsSync(join(current, "pnpm-workspace.yaml")) &&
    nodeFs.existsSync(join(current, "config/app.yaml"))
  )) {
    const parent = dirname(current);
    if (parent === current) throw new Error("Dépôt Veyra introuvable");
    current = parent;
  }
  return current;
}

export function loadVoiceConfig(
  file = process.env.VEYRA_CONFIG_DIR
    ? join(resolve(process.env.VEYRA_CONFIG_DIR), "voice.yaml")
    : join(repoRoot(), "config/voice.yaml"),
): VoiceConfig {
  return new ConfigLoader(configSchemas.voice).load([{ file }]).value;
}

/** <VEYRA_ENGINES_ROOT | enginesRoot>/<id>; refused inside the repository. */
export function engineRoot(
  config: VoiceConfig,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = env.VEYRA_ENGINES_ROOT || config.enginesRoot;
  const root = resolve(
    base.startsWith("~/") ? join(homedir(), base.slice(2)) : base,
    id,
  );
  let repo: string | null = null;
  try {
    repo = repoRoot();
  } catch {
    // Outside a checkout (VEYRA_CONFIG_DIR): nothing to protect.
  }
  const rel = repo === null ? ".." : relative(repo, root);
  if (!rel.startsWith("..") && !isAbsolute(rel))
    throw new Error(
      `Racine des moteurs dans le dépôt refusée : ${root} (définir VEYRA_ENGINES_ROOT hors du dépôt)`,
    );
  return root;
}

export function findEngine(config: VoiceConfig, id: string): EngineConfig {
  const engine = config.engines.find((e) => e.id === id);
  if (!engine)
    throw new Error(
      `Moteur inconnu : ${id} (configurés : ${config.engines.map((e) => e.id).join(", ") || "aucun"})`,
    );
  return engine;
}

const lockSchemaHashes = (raw: unknown): Record<string, string> => {
  const artefacts = (
    raw as { artefacts?: Record<string, { sha256?: unknown }> }
  )?.artefacts;
  return Object.fromEntries(
    Object.entries(artefacts ?? {}).flatMap(([name, a]) =>
      typeof a?.sha256 === "string" && /^[0-9a-f]{64}$/.test(a.sha256)
        ? [[name, a.sha256]]
        : [],
    ),
  );
};
function readLock(root: string, fs: Fs): Record<string, string> {
  try {
    return lockSchemaHashes(
      JSON.parse(fs.readFileSync(join(root, LOCK_FILE), "utf8") as string),
    );
  } catch {
    return {};
  }
}
const sha256Of = (path: string, fs: Fs) =>
  createHash("sha256").update(fs.readFileSync(path)).digest("hex");

/**
 * Offline status of one engine: config hashes first, lock-file hashes (trust on
 * first use) for unpinned artefacts. Never touches the network.
 */
export function engineStatus(
  engine: EngineConfig,
  root: string,
  fs: Fs = nodeFs,
): { state: EngineState; details: string[] } {
  const present = engine.artefacts.filter((a) =>
    fs.existsSync(join(root, a.name)),
  );
  if (present.length === 0) return { state: "non installé", details: [] };
  if (present.length < engine.artefacts.length)
    return {
      state: "incomplet",
      details: engine.artefacts
        .filter((a) => !present.includes(a))
        .map((a) => `manquant : ${a.name}`),
    };
  const lock = readLock(root, fs);
  const details: string[] = [];
  for (const a of engine.artefacts) {
    const path = join(root, a.name);
    const expected = a.sha256 ?? lock[a.name];
    // shortcut: hashes every artefact on each call (~140 Mo for Piper); cache by mtime if T117 calls it per synthesis.
    if (a.sizeBytes !== null && fs.statSync(path).size !== a.sizeBytes)
      details.push(`taille invalide : ${a.name}`);
    else if (!expected) details.push(`empreinte inconnue : ${a.name}`);
    else if (sha256Of(path, fs) !== expected)
      details.push(`empreinte invalide : ${a.name}`);
  }
  return details.length
    ? { state: "installé, empreinte invalide", details }
    : { state: "installé, empreintes vérifiées", details };
}

const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} Mio`;

export function doctorReport(
  config: VoiceConfig,
  env: NodeJS.ProcessEnv = process.env,
  fs: Fs = nodeFs,
): string {
  if (config.engines.length === 0) return "Aucun moteur configuré.";
  return config.engines
    .map((engine) => {
      const root = engineRoot(config, engine.id, env);
      const { state, details } = engineStatus(engine, root, fs);
      return [
        `${engine.id} ${engine.version} (${engine.kind}, ${engine.status === "candidate" ? "candidat" : "adopté"}) : ${state}`,
        `  racine : ${root}`,
        ...details.map((d) => `  ${d}`),
        ...engine.artefacts.map(
          (a) =>
            `  - ${a.name} — licence : ${a.licence}${a.attribution ? ` ; attribution : ${a.attribution}` : ""}`,
        ),
        ...(state === "non installé"
          ? [
              `  installation : pnpm voice:install ${engine.id} (autorisation requise)`,
            ]
          : []),
      ].join("\n");
    })
    .join("\n\n");
}

export interface InstallPlan {
  engine: EngineConfig;
  root: string;
  totalBytes: number | null;
  /** Reasons the plan cannot run; empty = runnable after confirmation. */
  blocked: string[];
  text: string;
}

export function planInstall(
  engine: EngineConfig,
  root: string,
  acceptUnpinned: string[] = [],
): InstallPlan {
  const blocked: string[] = [];
  for (const a of engine.artefacts) {
    if (!a.url)
      blocked.push(`${a.name} : URL non épinglée (${a.note ?? "à relever"})`);
    else if (!a.sha256 && !acceptUnpinned.includes(a.name))
      blocked.push(
        `${a.name} : empreinte inconnue ; refusé sans --accept-unpinned ${a.name} (empreinte calculée puis inscrite au verrou : confiance au premier usage)`,
      );
  }
  for (const name of acceptUnpinned)
    if (!engine.artefacts.some((a) => a.name === name))
      blocked.push(`--accept-unpinned ${name} : artefact inconnu`);
  const sizes = engine.artefacts.map((a) => a.sizeBytes);
  const totalBytes = sizes.includes(null)
    ? null
    : sizes.reduce<number>((s, n) => s + (n ?? 0), 0);
  const wheels = engine.artefacts.filter((a) => a.pypi);
  const text = [
    `Plan d'installation : ${engine.id} ${engine.version} (${engine.status === "candidate" ? "candidat, non adopté" : "adopté"})`,
    `Destination : ${root} (hors dépôt)`,
    ...engine.artefacts.map((a) =>
      [
        `- ${a.name}`,
        `    source : ${a.url ?? "non épinglée"}`,
        `    taille : ${a.sizeBytes === null ? "inconnue" : `${a.sizeBytes} octets (${mib(a.sizeBytes)})`}`,
        `    sha256 : ${a.sha256 ?? "inconnue (confiance au premier usage si acceptée)"}`,
        `    licence : ${a.licence}`,
        ...(a.attribution ? [`    attribution : ${a.attribution}`] : []),
        `    redistribution : ${a.redistribution}`,
      ].join("\n"),
    ),
    `Taille totale : ${totalBytes === null ? `inconnue (au moins ${mib(sizes.reduce<number>((s, n) => s + (n ?? 0), 0))})` : `${totalBytes} octets (${mib(totalBytes)})`}`,
    ...(wheels.length
      ? [
          "Roues Python : installées hors ligne depuis les fichiers vérifiés, étape ultérieure non exécutée par voice:install :",
          `    uv venv ${join(root, "venv")}`,
          `    uv pip install --python ${join(root, "venv/bin/python")} --no-index --find-links ${root} --require-hashes -r ${join(root, "requirements.txt")}`,
        ]
      : []),
    ...(blocked.length
      ? ["Installation impossible en l'état :", ...blocked.map((b) => `  ${b}`)]
      : []),
  ].join("\n");
  return { engine, root, totalBytes, blocked, text };
}

/** Streams the bytes of a URL; the default only accepts https. */
export type Fetcher = (
  url: string,
) => Promise<AsyncIterable<Uint8Array> | Iterable<Uint8Array>>;
export const httpsFetcher: Fetcher = async (url) => {
  if (!url.startsWith("https://"))
    throw new Error(`URL non https refusée : ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body)
    throw new Error(`Téléchargement refusé (${response.status}) : ${url}`);
  return response.body;
};

/** Downloads to a temp file in the root, checks size + sha256, then renames atomically. */
async function download(a: Artefact, root: string, fetcher: Fetcher) {
  const final = join(root, a.name);
  const part = join(root, `.${a.name}.${randomBytes(6).toString("hex")}.part`);
  const hash = createHash("sha256");
  let size = 0;
  const out = nodeFs.openSync(part, "wx", 0o644);
  try {
    for await (const chunk of await fetcher(a.url!)) {
      size += chunk.byteLength;
      if (a.sizeBytes !== null && size > a.sizeBytes)
        throw new Error(
          `${a.name} : taille supérieure à ${a.sizeBytes} octets`,
        );
      hash.update(chunk);
      nodeFs.writeSync(out, chunk);
    }
    nodeFs.fsyncSync(out);
    nodeFs.closeSync(out);
    const sha256 = hash.digest("hex");
    if (a.sizeBytes !== null && size !== a.sizeBytes)
      throw new Error(
        `${a.name} : taille ${size} ≠ ${a.sizeBytes} octets attendus`,
      );
    if (a.sha256 && sha256 !== a.sha256)
      throw new Error(`${a.name} : empreinte ${sha256} ≠ ${a.sha256} attendue`);
    nodeFs.renameSync(part, final);
    return { sha256, sizeBytes: size };
  } catch (error) {
    try {
      nodeFs.closeSync(out);
    } catch {
      // already closed
    }
    nodeFs.rmSync(part, { force: true });
    throw error;
  }
}

export interface InstallOptions {
  confirm: () => Promise<boolean>;
  log: (line: string) => void;
  fetcher?: Fetcher;
  acceptUnpinned?: string[];
}

/** Prints the plan, asks for confirmation, then installs; without confirmation nothing is written. */
export async function installEngine(
  engine: EngineConfig,
  root: string,
  { confirm, log, fetcher = httpsFetcher, acceptUnpinned = [] }: InstallOptions,
): Promise<"installed" | "blocked" | "cancelled"> {
  const plan = planInstall(engine, root, acceptUnpinned);
  log(plan.text);
  if (plan.blocked.length) {
    log("Aucun téléchargement effectué.");
    return "blocked";
  }
  if (!(await confirm())) {
    log(
      "Installation annulée : aucune confirmation, aucun téléchargement effectué.",
    );
    return "cancelled";
  }
  nodeFs.mkdirSync(root, { recursive: true, mode: 0o755 });
  const lock = readLock(root, nodeFs);
  const recorded: Record<string, object> = {};
  for (const a of engine.artefacts) {
    const path = join(root, a.name);
    const expected = a.sha256 ?? lock[a.name];
    let result: { sha256: string; sizeBytes: number };
    if (
      nodeFs.existsSync(path) &&
      expected &&
      sha256Of(path, nodeFs) === expected
    ) {
      log(`${a.name} : déjà présent, empreinte vérifiée.`);
      result = { sha256: expected, sizeBytes: nodeFs.statSync(path).size };
    } else {
      log(`${a.name} : téléchargement…`);
      result = await download(
        { ...a, sha256: expected ?? null },
        root,
        fetcher,
      );
      log(
        `${a.name} : ${result.sizeBytes} octets, sha256 ${result.sha256} vérifié.`,
      );
    }
    recorded[a.name] = {
      ...result,
      url: a.url,
      source: a.sha256 ? "pinned" : "trust-on-first-use",
    };
  }
  const wheels = engine.artefacts.filter((a) => a.pypi);
  if (wheels.length)
    writeAtomic(
      join(root, "requirements.txt"),
      wheels
        .map(
          (a) =>
            `${a.pypi!.project}==${a.pypi!.version} --hash=sha256:${a.sha256 ?? (recorded[a.name] as { sha256: string }).sha256}`,
        )
        .join("\n") + "\n",
    );
  writeAtomic(
    join(root, LOCK_FILE),
    JSON.stringify(
      {
        schemaVersion: 1,
        engine: engine.id,
        version: engine.version,
        installedAt: new Date().toISOString(),
        artefacts: recorded,
      },
      null,
      2,
    ) + "\n",
  );
  log(
    `Installé dans ${root}. Exécution hors ligne ensuite (sandbox sans réseau).`,
  );
  return "installed";
}
function writeAtomic(path: string, content: string) {
  const part = `${path}.${randomBytes(6).toString("hex")}.part`;
  nodeFs.writeFileSync(part, content, { flag: "wx" });
  nodeFs.renameSync(part, path);
}
