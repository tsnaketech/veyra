import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
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
} from "./index";

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
      PATH: [
        ...new Set([
          dirname(process.execPath),
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
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
