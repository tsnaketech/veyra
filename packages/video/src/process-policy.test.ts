import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  childEnv,
  MEDIA_FORMATS,
  VIDEO_FORMATS,
  compareFrames,
  extractFrameByIndex,
  extractFrames,
  extractFramesByIndex,
  probe,
  runProcess,
  SYSTEM_BIN_DIRS,
  systemBinary,
} from "./index";
import { setChildPathPrefixForTests } from "./testing";

/**
 * T132 regression and negative cases not covered by process.test.ts. Everything here
 * runs the real executor and real ffmpeg/ffprobe; nothing is mocked.
 */
let root: string, outside: string, clip: string, segment: string;
const saved: Record<string, string | undefined> = {};
const parentExtras = {
  HOME: "/home/parent-should-not-leak",
  LANG: "fr_FR.UTF-8",
  LC_ALL: "fr_FR.UTF-8",
  TZ: "Pacific/Auckland",
  DO_NOT_TRACK: "parent-should-not-leak",
  CLAUDE_CONFIG_DIR: "/parent-should-not-leak",
  HYPERFRAMES_TELEMETRY: "parent-should-not-leak",
  NODE_OPTIONS: "--no-warnings",
  ANTHROPIC_API_KEY: "sk-test-should-not-leak",
};
const ffmpegSource = (args: string[]) =>
  runProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args]);
beforeAll(async () => {
  for (const [key, value] of Object.entries(parentExtras)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  root = mkdtempSync(join(tmpdir(), "veyra-policy-"));
  outside = mkdtempSync(join(tmpdir(), "veyra-outside-"));
  clip = join(root, "clip.mp4");
  segment = join(outside, "secret-segment.ts");
  await ffmpegSource([
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
  // A media file outside the "project" directory, standing for another user's data.
  await ffmpegSource([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=48x24:rate=10:duration=1",
    "-c:v",
    "libx264",
    "-f",
    "mpegts",
    segment,
  ]);
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("child environment", () => {
  it("refuses secret-like keys in any case and every listed prefix/suffix, without spawning", async () => {
    const marker = join(root, "spawned-secret");
    const touch = [
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
    ];
    for (const key of [
      "anthropic_api_key",
      "Anthropic_Base_Url",
      "claude_code_oauth_token",
      "Aws_Profile",
      "github_sha",
      "openai_org",
      "npm_token",
      "Stripe_Secret",
      "db_password",
      "gcp_credentials",
      "GOOGLE_APPLICATION_CREDENTIAL",
      "api_key",
      "KEY",
    ]) {
      expect(() => childEnv({ [key]: "v" })).toThrow(/secret-like/);
      await expect(
        runProcess(process.execPath, touch, { env: { [key]: "v" } }),
      ).rejects.toThrow(/secret-like/);
    }
    // Not matched by the secret pattern but still refused by the allow-list.
    for (const key of [
      "API_KEY_FILE",
      "SSH_AUTH_SOCK",
      "DATABASE_URL",
      "NPM_AUTH",
      "home",
      "Path",
      "LD_PRELOAD",
    ])
      await expect(
        runProcess(process.execPath, touch, { env: { [key]: "v" } }),
      ).rejects.toThrow(/not allowed|secret-like/);
    expect(existsSync(marker)).toBe(false);
  });

  it("inherits nothing: PATH is fixed and allow-listed parent variables are not passed implicitly", async () => {
    const { stdout } = await runProcess(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify(process.env))",
    ]);
    // LANG is forced to C, not the parent's fr_FR.UTF-8.
    expect(JSON.parse(stdout)).toEqual({
      // System dirs first, node's own directory last (T127-sec N8).
      PATH: [
        ...new Set([
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          dirname(process.execPath),
        ]),
      ].join(":"),
      LANG: "C",
    });
    expect(stdout).not.toMatch(/should-not-leak|Auckland|fr_FR/);
  });

  it("T136b: a user-writable directory first on the parent PATH is never searched", async () => {
    // A fake ffmpeg the parent PATH would pick first (like ~/.local/bin).
    const bin = join(root, "user-bin");
    const marker = join(root, "shim-ran");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "ffmpeg"),
      `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`,
      { mode: 0o755 },
    );
    const original = process.env.PATH;
    process.env.PATH = `${bin}:${original}`;
    try {
      const { stderr, stdout } = await runProcess("ffmpeg", ["-version"]);
      expect(stdout + stderr).toMatch(/ffmpeg version/);
    } finally {
      process.env.PATH = original;
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("the prlimit wrapper (default path for ffmpeg/ffprobe) passes the same two variables", async () => {
    // A node child under explicit limits takes the same spawn path as ffmpeg.
    const { stdout } = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write(Object.keys(process.env).sort().join())"],
      {
        limits: { cpuSeconds: 10, fileSizeBytes: 1024 },
      },
    );
    expect(stdout).toBe("LANG,PATH");
  });

  it("T136b: MEDIA_LIMITS apply by basename, so an absolute .../ffmpeg is limited too", async () => {
    // node under the name ffmpeg reports the rlimits it really received.
    const dir = join(root, "abs-bin");
    mkdirSync(dir);
    const fake = join(dir, "ffmpeg");
    symlinkSync(process.execPath, fake);
    const { stdout } = await runProcess(fake, [
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('/proc/self/limits','utf8'))",
    ]);
    expect(stdout).toMatch(/Max cpu time\s+600\s+600\s+seconds/);
    expect(stdout).toMatch(/Max address space\s+8589934592\s+8589934592/);
  });
});

describe("probe() on unusual inputs", () => {
  it("T136b: refuses a symlink to a media file (lstat), like probeAudio", async () => {
    const link = join(root, "link.mp4");
    symlinkSync(clip, link);
    await expect(probe(link)).rejects.toThrow(/not a regular file/);
    await expect(
      extractFrameByIndex(link, 0, join(root, "l.png")),
    ).rejects.toThrow(/not a regular file/);
    expect(existsSync(join(root, "l.png"))).toBe(false);
  });

  it("T136b: a symlink to /etc/passwd is refused before spawning", async () => {
    const link = join(root, "passwd.mp4");
    symlinkSync("/etc/passwd", link);
    await expect(probe(link)).rejects.toThrow(/not a regular file/);
  });

  it("refuses a dangling symlink, a FIFO and a device before spawning (no hang)", async () => {
    const dangling = join(root, "dangling.mp4");
    symlinkSync(join(root, "nope.mp4"), dangling);
    const fifo = join(root, "pipe.mp4");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    for (const input of [dangling, fifo, "/dev/zero", "/dev/stdin"])
      await expect(probe(input)).rejects.toThrow(/not a regular file/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("handles spaces, unicode and protocol-looking characters in an absolute path as a plain file", async () => {
    const dir = join(root, "dossier avec espaces é 漢 ✓");
    mkdirSync(dir);
    for (const name of ["vidéo finale ✓.mp4", "concat:a|b.mp4", "http:x.mp4"]) {
      const file = join(dir, name);
      copyFileSync(clip, file);
      await expect(probe(file)).resolves.toMatchObject({ width: 64 });
    }
    // The same name given relatively looks like a URL and is refused (false refusal, safe).
    await expect(probe("concat:a|b.mp4")).rejects.toThrow(
      /Refused media input/,
    );
  });
});

describe("no public media function accepts a filter string (movie=/amovie=)", () => {
  it("numeric parameters that end up in -vf are validated, so a filter cannot be injected", async () => {
    const injected = "0),movie=/etc/passwd[x];[x]null(";
    await expect(
      extractFrameByIndex(clip, injected as never, join(root, "x.png")),
    ).rejects.toThrow();
    await expect(
      extractFramesByIndex(clip, [injected as never], root),
    ).rejects.toThrow();
    await expect(extractFrames(clip, [injected as never])).rejects.toThrow();
    expect(existsSync(join(root, "x.png"))).toBe(false);
  });

  it("RESIDUAL: runProcess stays low-level: a lavfi graph without a file marker still opens movie=", async () => {
    const graph = (marked: boolean) => [
      "-v",
      "error",
      ...(marked ? ["-protocol_whitelist", "file"] : []),
      "-f",
      "lavfi",
      "-i",
      `movie=${clip}`,
      "-show_entries",
      "stream=width",
      "-of",
      "csv=p=0",
    ];
    // Marked as a file input, the lavfi demuxer itself is off the format list.
    await expect(runProcess("ffprobe", graph(true))).rejects.toMatchObject({
      stderrTail: expect.stringMatching(/Format not on whitelist/),
    });
    // Unmarked, the executor applies no policy: callers must never pass
    // model/user-controlled argv (binary allow-list planned with T127).
    const { stdout } = await runProcess("ffprobe", graph(false));
    expect(stdout.trim()).toBe("64");
  });
});

describe("demuxers that reference other files (closed by -format_whitelist, T136b)", () => {
  const playlist = (name: string, uri: string) => {
    const path = join(root, name);
    writeFileSync(
      path,
      `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\n${uri}\n#EXT-X-ENDLIST\n`,
    );
    return path;
  };

  const refused = {
    name: "ProcessError",
    stderrTail: expect.stringMatching(/Format not on whitelist/),
  };

  it("an HLS playlist under the project no longer reads a .ts segment OUTSIDE it", async () => {
    const outsidePlaylist = playlist("outside.m3u8", segment);
    await expect(probe(outsidePlaylist)).rejects.toMatchObject(refused);
    await expect(
      extractFrameByIndex(outsidePlaylist, 0, join(root, "h.png")),
    ).rejects.toMatchObject(refused);
    expect(existsSync(join(root, "h.png"))).toBe(false);
    await expect(
      probe(playlist("passwd.m3u8", "/etc/passwd")),
    ).rejects.toMatchObject(refused);
  });

  it("an ffconcat list named .mp4 no longer reads a sibling file", async () => {
    const path = join(root, "looks-like-a-render.mp4");
    writeFileSync(path, "ffconcat version 1.0\nfile clip.mp4\n");
    await expect(probe(path)).rejects.toMatchObject(refused);
    await expect(
      extractFrameByIndex(path, 2, join(root, "c.png")),
    ).rejects.toMatchObject(refused);
    expect(existsSync(join(root, "c.png"))).toBe(false);
    // Control: the real clip still decodes and compares through the same functions.
    const a = await extractFrameByIndex(clip, 2, join(root, "d.png"));
    expect(await compareFrames(a, a)).toBe(Infinity);
  });

  it("the executor adds MEDIA_FORMATS to a raw file input (audio paths), directly or under prlimit", async () => {
    const hls = playlist("raw.m3u8", segment);
    const probeArgs = ["-v", "error", "-protocol_whitelist", "file", hls];
    await expect(runProcess("ffprobe", probeArgs)).rejects.toMatchObject(
      refused,
    );
    await expect(
      runProcess("/usr/bin/prlimit", [
        "--cpu=10",
        "--",
        "ffprobe",
        ...probeArgs,
      ]),
    ).rejects.toMatchObject(refused);
    // Control: a regular media file under the same raw argv is accepted.
    await expect(
      runProcess("ffprobe", [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        clip,
      ]),
    ).resolves.toBeDefined();
  });

  it("MEDIA_FORMATS covers every allowedFormats entry of config/audio.yaml; VIDEO_FORMATS excludes audio-only and list demuxers", () => {
    const yaml = readFileSync(
      join(__dirname, "../../../config/audio.yaml"),
      "utf8",
    );
    const allowed = /allowedFormats:\s*\[([^\]]*)\]/
      .exec(yaml)![1]
      .split(",")
      .map((f) => f.trim());
    const media = MEDIA_FORMATS.split(",");
    for (const format of allowed) expect(media).toContain(format);
    for (const format of ["hls", "concat", "matroska", "wav", "mp3"])
      expect(VIDEO_FORMATS.split(",")).not.toContain(format);
  });
});

describe("T127-sec N7: every ffmpeg/ffprobe input carries the file and demuxer lists", () => {
  let shims: string, marker: string;
  beforeAll(() => {
    // Recording shims: any spawn of ffmpeg/ffprobe/prlimit leaves the marker.
    shims = mkdtempSync(join(tmpdir(), "veyra-n7-"));
    marker = join(shims, "spawned");
    for (const name of ["ffmpeg", "ffprobe", "prlimit"]) {
      writeFileSync(
        join(shims, name),
        `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`,
      );
      chmodSync(join(shims, name), 0o755);
    }
    setChildPathPrefixForTests(shims);
  });
  afterAll(() => {
    setChildPathPrefixForTests(undefined);
    rmSync(shims, { recursive: true, force: true });
  });
  const refusedBeforeSpawn = async (
    command: string,
    args: string[],
    why: RegExp,
  ) => {
    await expect(runProcess(command, args)).rejects.toThrow(why);
    expect(existsSync(marker)).toBe(false);
  };

  it("a bare -i file, an unlisted ffprobe input and a graph without -f lavfi are refused before spawning", async () => {
    const out = join(root, "n7.png");
    await refusedBeforeSpawn(
      "ffmpeg",
      ["-i", clip, "-frames:v", "1", out],
      /without -protocol_whitelist file/,
    );
    // The protocol list alone is not enough when another input follows unmarked.
    await refusedBeforeSpawn(
      "ffmpeg",
      [
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        VIDEO_FORMATS,
        "-i",
        clip,
        "-i",
        segment,
        out,
      ],
      /input ".*secret-segment.ts" without -protocol_whitelist file/,
    );
    await refusedBeforeSpawn("ffprobe", ["-v", "error", clip], /without/);
    await refusedBeforeSpawn(
      "ffmpeg",
      ["-i", "testsrc=size=8x8:duration=0.1", "-f", "null", "-"],
      /without -protocol_whitelist file/,
    );
    // Same rules under an explicit prlimit wrapper (the audio path).
    await refusedBeforeSpawn(
      "prlimit",
      ["--cpu=5", "--", "ffmpeg", "-i", clip, out],
      /without -protocol_whitelist file/,
    );
    expect(existsSync(out)).toBe(false);
  });

  it("-protocol_whitelist other than exactly file, or a list demuxer, is refused before spawning", async () => {
    for (const protocols of ["file,pipe", "file,http", "pipe", "FILE", ""])
      await refusedBeforeSpawn(
        "ffmpeg",
        ["-protocol_whitelist", protocols, ...["-i", clip, "-f", "null", "-"]],
        /must be exactly file/,
      );
    for (const formats of ["hls", "mov,concat", "lavfi", "mov,"])
      await refusedBeforeSpawn(
        "ffprobe",
        ["-protocol_whitelist", "file", "-format_whitelist", formats, clip],
        /is not allowed/,
      );
  });

  it("controls: fileInput, the executor's default list and an explicit -f lavfi graph do spawn", async () => {
    setChildPathPrefixForTests(undefined);
    try {
      await expect(
        runProcess("ffmpeg", [
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-ss",
          "0.1",
          "-i",
          clip,
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=8x8:d=0.1",
          "-f",
          "null",
          "-",
        ]),
      ).resolves.toBeDefined();
    } finally {
      setChildPathPrefixForTests(shims);
    }
  });
});

describe("T127-sec N8: tools resolved once under system dirs only", () => {
  it("ffmpeg, ffprobe, prlimit and bwrap resolve to absolute paths under /usr/local/bin, /usr/bin, /bin", () => {
    expect(SYSTEM_BIN_DIRS).toEqual(["/usr/local/bin", "/usr/bin", "/bin"]);
    for (const name of ["ffmpeg", "ffprobe", "prlimit", "bwrap"]) {
      const path = systemBinary(name);
      if (path === undefined) continue; // bwrap may be absent; the sandbox then refuses.
      expect(SYSTEM_BIN_DIRS).toContain(dirname(path));
      expect(path).toBe(
        SYSTEM_BIN_DIRS.map((dir) => join(dir, name)).find(existsSync),
      );
    }
    expect(systemBinary("veyra-no-such-tool")).toBeUndefined();
  });

  it("a fake ffmpeg next to a user-writable node is never executed (direct, under prlimit, or from a node child)", async () => {
    // A copy of node in a temp dir stands for a user-writable node install (nvm, ~/.local).
    const bin = mkdtempSync(join(tmpdir(), "veyra-n8-"));
    try {
      const marker = join(bin, "fake-ran");
      copyFileSync(process.execPath, join(bin, "node"));
      chmodSync(join(bin, "node"), 0o755);
      for (const name of ["ffmpeg", "ffprobe", "prlimit"])
        writeFileSync(
          join(bin, name),
          `#!/bin/sh\necho fake >> ${JSON.stringify(marker)}\n`,
          { mode: 0o755 },
        );
      // A node-based child (like HyperFrames) looking ffmpeg up on the child PATH.
      const lookup = join(bin, "lookup.cjs");
      writeFileSync(
        lookup,
        `const out = require("node:child_process").execFileSync("ffmpeg", ["-version"]).toString();
process.stdout.write(out.split("\\n")[0] + "|" + process.env.PATH);
`,
      );
      const script = join(bin, "run.mts");
      writeFileSync(
        script,
        `import { runProcess } from ${JSON.stringify(join(__dirname, "process.ts"))};
const first = (s: string) => s.split("\\n")[0];
const direct = await runProcess("ffmpeg", ["-version"]);
const wrapped = await runProcess("prlimit", ["--cpu=5", "--", "ffmpeg", "-version"]);
const child = await runProcess(process.execPath, [${JSON.stringify(lookup)}]);
process.stdout.write(JSON.stringify({ direct: first(direct.stdout), wrapped: first(wrapped.stdout), child: child.stdout, execPath: process.execPath }));
`,
      );
      const result = JSON.parse(
        execFileSync(
          join(bin, "node"),
          ["--experimental-transform-types", "--no-warnings", script],
          {
            env: { PATH: `${bin}:${process.env.PATH}`, VITEST: "" },
            encoding: "utf8",
          },
        ),
      );
      expect(result.execPath).toBe(join(bin, "node"));
      expect(result.direct).toMatch(/^ffmpeg version/);
      expect(result.wrapped).toMatch(/^ffmpeg version/);
      const [version, path] = result.child.split("|");
      expect(version).toMatch(/^ffmpeg version/);
      // node's directory is on the child PATH, but last.
      expect(path.split(":").at(-1)).toBe(bin);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("the test hook is not part of the public entry and refuses to run outside Vitest", async () => {
    expect(Object.keys(await import("./index"))).not.toContain(
      "setChildPathPrefixForTests",
    );
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => setChildPathPrefixForTests("/tmp")).toThrow(
        /outside Vitest/,
      );
    } finally {
      process.env.VITEST = saved;
    }
  });
});
