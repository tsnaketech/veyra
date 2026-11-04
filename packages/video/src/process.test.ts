import { afterAll, beforeAll, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_ENV_KEYS, probe, runProcess } from "./index";
import { probeVideoStream } from "./stream";

// Fake secrets in the parent: a child must never see them (T132).
const secrets = {
  ANTHROPIC_API_KEY: "sk-test-should-not-leak",
  CLAUDE_CODE_MESSAGING_TOKEN: "x-should-not-leak",
  MY_SERVICE_TOKEN: "y-should-not-leak",
  AWS_SECRET_ACCESS_KEY: "z-should-not-leak",
};
let root: string, clip: string, server: Server, port: number;
let connections = 0;
beforeAll(async () => {
  Object.assign(process.env, secrets);
  root = mkdtempSync(join(tmpdir(), "veyra-process-"));
  clip = join(root, "clip.mp4");
  await runProcess("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x36:rate=10:duration=0.5",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    clip,
  ]);
  server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  for (const key of Object.keys(secrets)) delete process.env[key];
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

const printEnv = ["-e", "process.stdout.write(JSON.stringify(process.env))"];

it("gives a real child only the allow-listed environment, never the parent's", async () => {
  const { stdout } = await runProcess(process.execPath, printEnv);
  const env = JSON.parse(stdout) as Record<string, string>;
  expect(Object.keys(env).sort()).toEqual(["LANG", "PATH"]);
  for (const value of Object.values(secrets))
    expect(stdout).not.toContain(value);
  const extra = await runProcess(process.execPath, printEnv, {
    env: { HOME: "/home/test", DO_NOT_TRACK: "1", TZ: undefined },
  });
  expect(JSON.parse(extra.stdout)).toEqual({
    PATH: env.PATH,
    LANG: "C",
    HOME: "/home/test",
    DO_NOT_TRACK: "1",
  });
  expect(CHILD_ENV_KEYS).not.toContain("ANTHROPIC_API_KEY");
});

it("refuses a secret-like or unlisted variable in an explicit env without spawning", async () => {
  const marker = join(root, "spawned");
  const touch = [
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
  ];
  for (const key of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "MY_SERVICE_TOKEN",
    "SOME_API_KEY",
    "DB_SECRET",
    "AWS_REGION",
    "GITHUB_ACTIONS",
    "OPENAI_BASE_URL",
  ])
    await expect(
      runProcess(process.execPath, touch, { env: { [key]: "v" } }),
    ).rejects.toThrow(/secret-like/);
  await expect(
    runProcess(process.execPath, touch, { env: { NODE_OPTIONS: "--x" } }),
  ).rejects.toThrow(/not allowed/);
  expect(existsSync(marker)).toBe(false);
});

it("refuses shells and option-like commands", async () => {
  for (const command of ["sh", "/bin/bash", "/usr/bin/env", "dash", "-c", ""])
    await expect(runProcess(command, ["-c", "id"])).rejects.toThrow(
      /argv only, no shell/,
    );
});

it("wraps ffmpeg and ffprobe in prlimit (CPU, file size, address space)", async () => {
  // A real ffprobe under the default limits; prlimit failure would reject.
  const { stdout } = await runProcess("ffprobe", [
    "-v",
    "error",
    "-protocol_whitelist",
    "file",
    "-show_entries",
    "format=format_name",
    "-of",
    "csv=p=0",
    clip,
  ]);
  expect(stdout.trim()).toContain("mp4");
  // The limits really reach the child: a node child under explicit limits reads them.
  const limits = await runProcess(
    process.execPath,
    [
      "-e",
      'process.stdout.write(require("node:fs").readFileSync("/proc/self/limits","utf8"))',
    ],
    {
      limits: {
        cpuSeconds: 7,
        fileSizeBytes: 4096,
        addressSpaceBytes: 16 * 1024 ** 3,
      },
    },
  );
  expect(limits.stdout).toMatch(/Max cpu time\s+7\s+7/);
  expect(limits.stdout).toMatch(/Max file size\s+4096\s+4096/);
  expect(limits.stdout).toMatch(
    /Max address space\s+17179869184\s+17179869184/,
  );
});

it("probe() refuses protocol URLs, option-like paths and non-files before spawning", async () => {
  for (const input of [
    "concat:/etc/passwd|/etc/passwd",
    `http://127.0.0.1:${port}/x.mp4`,
    "data:video/mp4;base64,AAAA",
    "file:/etc/passwd",
    "subfile,,start,0,end,0,,:/etc/passwd",
    "-f",
  ])
    // subfile,… has no scheme prefix: resolve() turns it into a missing local path.
    await expect(probe(input)).rejects.toThrow(
      /Refused media input|not a regular file/,
    );
  await expect(probe(root)).rejects.toThrow(/not a regular file/);
  await expect(probe(join(root, "missing.mp4"))).rejects.toThrow(
    /not a regular file/,
  );
  await expect(probeVideoStream("concat:a|b", 1000)).rejects.toThrow(
    /Refused media input/,
  );
  expect(connections).toBe(0);
});

it("an HLS playlist is refused by probe(); with hls forced, the protocol list still blocks network and nested protocols", async () => {
  const segment = join(root, "seg.ts");
  await runProcess("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x36:rate=10:duration=1",
    "-c:v",
    "libx264",
    "-f",
    "mpegts",
    segment,
  ]);
  const playlist = (uri: string) => {
    const path = join(root, `p${Math.random().toString(36).slice(2)}.m3u8`);
    writeFileSync(
      path,
      `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\n${uri}\n#EXT-X-ENDLIST\n`,
    );
    return path;
  };
  const b64 = readFileSync(segment).toString("base64");
  // T136b: the demuxer list refuses the playlist itself, before any segment is opened.
  await expect(probe(playlist(segment))).rejects.toMatchObject({
    stderrTail: expect.stringMatching(/Format not on whitelist/),
  });
  // Defence in depth: hls explicitly allowed, the protocol list is what still holds.
  const forced = (path: string) =>
    runProcess("ffprobe", [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      "hls,mpegts",
      "-show_streams",
      path,
    ]);
  // Control: the playlist mechanism itself works with a plain local segment.
  await expect(forced(playlist(segment))).resolves.toBeDefined();
  // Our flag, not ffmpeg's HLS default ('file,crypto,data'), is what refuses http.
  await expect(
    forced(playlist(`http://127.0.0.1:${port}/x.ts`)),
  ).rejects.toMatchObject({
    stderrTail: expect.stringContaining(
      "Protocol 'http' not on whitelist 'file'!",
    ),
  });
  for (const uri of [
    `concat:${segment}|${segment}`,
    `data:video/mp2t;base64,${b64}#.ts`,
  ])
    await expect(forced(playlist(uri))).rejects.toMatchObject({
      stderrTail: expect.stringMatching(
        /not on whitelist|Error when loading first segment|allowed_segment_extensions/,
      ),
    });
  expect(connections).toBe(0);
});
