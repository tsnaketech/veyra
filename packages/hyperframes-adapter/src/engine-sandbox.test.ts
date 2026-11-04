import { afterAll, beforeAll, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
