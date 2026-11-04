import { afterAll, beforeAll, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runEngine } from "./sandbox";

// Real bwrap, no network involved: the probe targets a listener of this test on host loopback.
const bwrap = spawnSync("/usr/bin/bwrap", [
  "--ro-bind",
  "/",
  "/",
  "--unshare-net",
  "/usr/bin/true",
]);
const usable = bwrap.status === 0;
let engineRoot: string, outputDir: string, server: Server, port: number;
let accepted = 0;
beforeAll(async () => {
  engineRoot = mkdtempSync(join(tmpdir(), "veyra-engine-"));
  outputDir = mkdtempSync(join(tmpdir(), "veyra-engine-out-"));
  server = createServer((socket) => {
    accepted++;
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
  writeFileSync(
    join(engineRoot, "probe.mjs"),
    `import { connect } from "node:net";
import { writeFileSync } from "node:fs";
const [engineRoot, port] = process.argv.slice(2);
let engineWrite = "written";
try { writeFileSync(engineRoot + "/tamper", "x"); } catch (e) { engineWrite = e.code; }
const net = await new Promise((done) => {
  const s = connect(Number(port), "127.0.0.1");
  s.once("connect", () => { s.destroy(); done("connected"); });
  s.once("error", (e) => done(e.code));
});
writeFileSync("result.json", JSON.stringify({ net, engineWrite, env: process.env }));
`,
  );
});
afterAll(() => {
  server?.close();
  rmSync(engineRoot, { recursive: true, force: true });
  rmSync(outputDir, { recursive: true, force: true });
});

it.skipIf(!usable)(
  "runs an engine without network, engine root read-only, output writable (skipped if bwrap cannot create a network namespace)",
  async () => {
    // Control: the listener is reachable from the host namespace.
    await new Promise<void>((done, fail) =>
      connect(port, "127.0.0.1")
        .once("connect", function (this: { destroy(): void }) {
          this.destroy();
          done();
        })
        .once("error", fail),
    );
    await new Promise((done) => setTimeout(done, 50));
    const before = accepted;
    // Fake secrets in the parent must not reach the sandboxed child (T132).
    const secrets = {
      ANTHROPIC_API_KEY: "sk-test-should-not-leak",
      CLAUDE_CODE_MESSAGING_TOKEN: "x-should-not-leak",
      MY_SERVICE_TOKEN: "y-should-not-leak",
    };
    Object.assign(process.env, secrets);
    await runEngine(
      process.execPath,
      [join(engineRoot, "probe.mjs"), engineRoot, String(port)],
      { engineRoot, outputDir },
      { wallTimeoutMs: 20000, cpuSeconds: 10, maxOutputBytes: 1024 * 1024 },
    ).finally(() => {
      for (const key of Object.keys(secrets)) delete process.env[key];
    });
    const result = JSON.parse(
      readFileSync(join(outputDir, "result.json"), "utf8"),
    );
    expect(result.net).toBe("ECONNREFUSED");
    expect(result.engineWrite).toBe("EROFS");
    expect(Object.keys(result.env).sort()).toEqual([
      "DO_NOT_TRACK",
      "HOME",
      "HYPERFRAMES_SKIP_SKILLS",
      "HYPERFRAMES_TELEMETRY",
      "LANG",
      "PATH",
      "PWD", // set by bwrap --chdir
    ]);
    expect(JSON.stringify(result.env)).not.toMatch(/should-not-leak/);
    expect(accepted).toBe(before);
  },
);

it("refuses overlapping engine and output directories", () => {
  expect(() =>
    runEngine("/bin/true", [], { engineRoot, outputDir: engineRoot }),
  ).toThrow("disjoint");
});

// T136b: a Unix socket the test owns under the host's XDG runtime dir (D-Bus, gnupg and
// pulse live there). Real bwrap, real connect(): the sandbox must see neither the path
// nor the socket.
const runtimeDir =
  process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;
const runtimeWritable = (() => {
  try {
    accessSync(runtimeDir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
})();
it.skipIf(!usable || !runtimeWritable)(
  "a sandboxed child can neither connect to nor see a host socket under /run/user (skipped without bwrap or a writable XDG runtime dir)",
  async () => {
    const dir = mkdtempSync(join(runtimeDir, "veyra-sock-"));
    const socketPath = join(dir, "host.sock");
    let hits = 0;
    const host = createServer((socket) => {
      hits++;
      socket.destroy();
    });
    await new Promise<void>((done) => host.listen(socketPath, done));
    try {
      // Control: reachable from the host.
      await new Promise<void>((done, fail) =>
        connect(socketPath).once("connect", done).once("error", fail),
      );
      await new Promise((done) => setTimeout(done, 50));
      const before = hits;
      writeFileSync(
        join(engineRoot, "socket-probe.mjs"),
        `import { connect } from "node:net";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
const [socketPath, runtimeDir] = process.argv.slice(2);
const attempt = (path) => new Promise((done) => {
  const s = connect(path);
  s.once("connect", () => { s.destroy(); done("connected"); });
  s.once("error", (e) => done(e.code));
});
let run;
try { run = readdirSync("/run"); } catch (e) { run = e.code; }
writeFileSync("socket.json", JSON.stringify({
  connect: await attempt(socketPath),
  bus: await attempt(runtimeDir + "/bus"),
  systemBus: await attempt("/run/dbus/system_bus_socket"),
  visible: existsSync(socketPath),
  runtimeVisible: existsSync(runtimeDir),
  run,
}));
`,
      );
      await runEngine(
        process.execPath,
        [join(engineRoot, "socket-probe.mjs"), socketPath, runtimeDir],
        { engineRoot, outputDir },
        { wallTimeoutMs: 20000, cpuSeconds: 10, maxOutputBytes: 1024 * 1024 },
      );
      const result = JSON.parse(
        readFileSync(join(outputDir, "socket.json"), "utf8"),
      );
      expect(result).toEqual({
        connect: "ENOENT",
        bus: "ENOENT",
        systemBus: "ENOENT",
        visible: false,
        runtimeVisible: false,
        run: [],
      });
      expect(hits).toBe(before);
    } finally {
      host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(!usable)(
  "--new-session: a wall-clock timeout still kills the whole sandbox (no orphan keeps writing)",
  async () => {
    writeFileSync(
      join(engineRoot, "spin.mjs"),
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
// A detached grandchild in its own group, as a renderer's browser would be.
spawn(process.execPath, ["-e", "setInterval(() => require('node:fs').writeFileSync('beat', String(Date.now())), 50)"], { detached: true, stdio: "ignore" });
setInterval(() => writeFileSync("alive", String(Date.now())), 50);
`,
    );
    await expect(
      runEngine(
        process.execPath,
        [join(engineRoot, "spin.mjs")],
        { engineRoot, outputDir },
        { wallTimeoutMs: 1500, cpuSeconds: 10, maxOutputBytes: 1024 * 1024 },
      ),
    ).rejects.toThrow(/timeout/);
    await new Promise((done) => setTimeout(done, 300));
    const beat = join(outputDir, "beat");
    expect(existsSync(beat)).toBe(true);
    const settled = statSync(beat).mtimeMs;
    await new Promise((done) => setTimeout(done, 500));
    expect(statSync(beat).mtimeMs).toBe(settled);
  },
);

// T127-sec N2: a file and a Unix socket the test owns under the real $HOME, plus the
// host's ~/.ssh, ~/.claude and ~/.config, must be invisible from inside the sandbox.
it.skipIf(!usable)(
  "$HOME is masked: a test file and socket under the real $HOME, ~/.ssh, ~/.claude and ~/.config are invisible",
  async () => {
    const home = homedir();
    const dir = mkdtempSync(join(home, ".veyra-home-probe-"));
    const secretFile = join(dir, "secret.txt");
    const socketPath = join(dir, "home.sock");
    writeFileSync(secretFile, "should-not-leak");
    let hits = 0;
    const host = createServer((socket) => {
      hits++;
      socket.destroy();
    });
    await new Promise<void>((done) => host.listen(socketPath, done));
    try {
      // Control: both are reachable from the host.
      expect(readFileSync(secretFile, "utf8")).toBe("should-not-leak");
      await new Promise<void>((done, fail) =>
        connect(socketPath).once("connect", done).once("error", fail),
      );
      await new Promise((done) => setTimeout(done, 50));
      const before = hits;
      writeFileSync(
        join(engineRoot, "home-probe.mjs"),
        `import { connect } from "node:net";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const [home, file, socketPath] = process.argv.slice(2);
const read = (path) => { try { return readFileSync(path, "utf8"); } catch (e) { return e.code; } };
const list = (path) => { try { return readdirSync(path); } catch (e) { return e.code; } };
const attempt = (path) => new Promise((done) => {
  const s = connect(path);
  s.once("connect", () => { s.destroy(); done("connected"); });
  s.once("error", (e) => done(e.code));
});
writeFileSync("home.json", JSON.stringify({
  file: read(file),
  fileVisible: existsSync(file),
  socket: await attempt(socketPath),
  ssh: list(home + "/.ssh"),
  claude: list(home + "/.claude"),
  credentials: read(home + "/.claude/.credentials.json"),
  config: list(home + "/.config"),
  home: list(home),
}));
`,
      );
      await runEngine(
        process.execPath,
        [join(engineRoot, "home-probe.mjs"), home, secretFile, socketPath],
        { engineRoot, outputDir },
        { wallTimeoutMs: 20000, cpuSeconds: 10, maxOutputBytes: 1024 * 1024 },
      );
      const result = JSON.parse(
        readFileSync(join(outputDir, "home.json"), "utf8"),
      );
      expect(result).toMatchObject({
        file: "ENOENT",
        fileVisible: false,
        socket: "ENOENT",
        ssh: "ENOENT",
        claude: "ENOENT",
        credentials: "ENOENT",
        config: "ENOENT",
      });
      // Only mount points of the read-only re-binds remain (e.g. .cache, the repo path).
      for (const name of [".ssh", ".claude", ".config", basename(dir)])
        expect(result.home).not.toContain(name);
      expect(hits).toBe(before);
    } finally {
      host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(!usable)(
  "RESIDUAL: a socket under a read-only bound path (the engine root) stays connectable",
  async () => {
    // Read-only binds do not stop connect(); only what is bound is exposed ($HOME is
    // masked, T127-sec N2). If this starts failing, update SECURITY.md.
    const socketPath = join(engineRoot, "ro.sock");
    const host = createServer((socket) => socket.destroy());
    await new Promise<void>((done) => host.listen(socketPath, done));
    try {
      writeFileSync(
        join(engineRoot, "ro-probe.mjs"),
        `import { connect } from "node:net";
import { writeFileSync } from "node:fs";
const s = connect(process.argv[2]);
s.once("connect", () => { s.destroy(); writeFileSync("ro.json", '"connected"'); });
s.once("error", (e) => writeFileSync("ro.json", JSON.stringify(e.code)));
`,
      );
      await runEngine(
        process.execPath,
        [join(engineRoot, "ro-probe.mjs"), socketPath],
        { engineRoot, outputDir },
        { wallTimeoutMs: 20000, cpuSeconds: 10, maxOutputBytes: 1024 * 1024 },
      );
      expect(JSON.parse(readFileSync(join(outputDir, "ro.json"), "utf8"))).toBe(
        "connected",
      );
    } finally {
      host.close();
    }
  },
);
