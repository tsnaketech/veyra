import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  analyzeFlashes,
  compareFrames,
  extractFrameByIndex,
  extractFramesByIndex,
  probe,
  runProcess,
  setChildPathPrefixForTests
} from '@veyra/video';
import {
  analyzeAudio,
  detectOnsets,
  mixToWav,
  muxAudio,
  probeAudio,
  voiceProvider
} from '@veyra/audio';
import { colorEngine } from '../test-engines';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

/**
 * T132: real ffmpeg/ffprobe behind a recording shim placed first on the child PATH. The
 * child PATH is fixed (T136b), so the shim directory goes through the Vitest-only hook
 * setChildPathPrefixForTests, never through the parent PATH. The shim
 * writes the environment, argv and rlimits it actually received, then execs the real
 * binary, so every public media path below runs for real and is observed from the child.
 */
const secrets = {
  ANTHROPIC_API_KEY: 'sk-test-should-not-leak',
  CLAUDE_CODE_MESSAGING_TOKEN: 'x-should-not-leak',
  MY_SERVICE_TOKEN: 'y-should-not-leak'
};
const realBinary = (name: string) =>
  (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => join(dir, name))
    .find((path) => existsSync(path))!;
let root: string, shims: string, records: string, clip: string, wav: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'veyra-env-'));
  clip = join(root, 'clip.mp4');
  wav = join(root, 'tone.wav');
  await runProcess('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=160x90:rate=30:duration=0.6',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    clip
  ]);
  await runProcess('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    wav
  ]);
  shims = join(root, 'bin');
  records = join(root, 'records');
  mkdirSync(shims);
  mkdirSync(records);
  for (const name of ['ffmpeg', 'ffprobe']) {
    const shim = join(shims, name);
    writeFileSync(
      shim,
      `#!/bin/sh
r=${JSON.stringify(records)}/${name}-$$
env > "$r.env"
printf '%s\\n' "$@" > "$r.args"
cat /proc/self/limits > "$r.limits"
exec ${JSON.stringify(realBinary(name))} "$@"
`
    );
    chmodSync(shim, 0o755);
  }
  Object.assign(process.env, secrets);
  setChildPathPrefixForTests(shims);
});
afterAll(() => {
  setChildPathPrefixForTests(undefined);
  for (const key of Object.keys(secrets)) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
});

const track = {
  trackId: 'atr_env',
  category: 'music',
  get assetPath() {
    return wav;
  },
  startMs: 0,
  sourceInMs: 0,
  playMs: 500,
  gainDb: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
  loop: false,
  duck: []
} as never;
// Variables a POSIX sh adds by itself before `env` runs.
const shellOwn = ['PWD', 'OLDPWD', 'SHLVL', '_'];
it.each([
  ['probe', async () => void (await probe(clip))],
  [
    'extractFrameByIndex',
    async () => void (await extractFrameByIndex(clip, 3, join(root, 'f3.png')))
  ],
  ['extractFramesByIndex', async () => void (await extractFramesByIndex(clip, [1, 4], root))],
  [
    'compareFrames',
    async () => {
      const a = await extractFrameByIndex(clip, 2, join(root, 'a.png'));
      expect(await compareFrames(a, a)).toBe(Infinity);
    }
  ],
  ['analyzeFlashes (streamFrames)', async () => void (await analyzeFlashes(clip))],
  ['probeAudio (runAudioProcess)', async () => void (await probeAudio(wav))],
  ['analyzeAudio', async () => void (await analyzeAudio(wav))],
  ['detectOnsets', async () => void (await detectOnsets(wav))],
  [
    'mixToWav',
    async () =>
      mixToWav([track], join(root, `mix-${Math.random().toString(36).slice(2)}.wav`), {}, 600)
  ],
  [
    'muxAudio',
    async () => muxAudio(clip, wav, join(root, `mux-${Math.random().toString(36).slice(2)}.mp4`))
  ],
  [
    'fake voice synthesis (lavfi tone)',
    async () =>
      void (await voiceProvider('fake').synthesize!(
        { sceneId: 'scn_env', text: 'Bonjour' },
        join(root, `voice-${Math.random().toString(36).slice(2)}.wav`)
      ))
  ],
  [
    'colorEngine render',
    async () => {
      // Only the fields colorEngine reads.
      const board = {
        width: 160,
        height: 90,
        scenes: [{ text: 'a', duration: 500, animation: { enter: 'fade' } }]
      } as never;
      const out = join(root, 'revisions', 'rev_env', 'out.mp4');
      mkdirSync(join(root, 'revisions', 'rev_env'), { recursive: true });
      await colorEngine(() => board).render(root, { outputPath: out } as never);
    }
  ]
])('%s: the real ffmpeg/ffprobe child receives no secret', async (_name, run) => {
  for (const file of readdirSync(records)) rmSync(join(records, file));
  await run();
  const files = readdirSync(records).filter((file) => file.endsWith('.env'));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const text = readFileSync(join(records, file), 'utf8');
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
    const keys = text
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('=')[0]);
    for (const key of keys) expect(['PATH', 'LANG', 'LC_ALL', ...shellOwn]).toContain(key);
    const base = join(records, file.slice(0, -4));
    // Every media input is preceded by the protocol and demuxer whitelists (lavfi graphs
    // excepted); a raw input gets the executor's default demuxer list (T136b).
    const args = readFileSync(`${base}.args`, 'utf8').split('\n');
    args.forEach((arg, i) => {
      if (arg === '-i' && args[i - 1] !== 'lavfi') {
        expect(args.slice(i - 4, i - 1)).toEqual([
          '-protocol_whitelist',
          'file',
          '-format_whitelist'
        ]);
        expect(args[i - 1]).not.toMatch(/hls|concat|lavfi/);
      }
    });
    if (file.startsWith('ffprobe'))
      expect(args).toEqual(expect.arrayContaining(['-protocol_whitelist', '-format_whitelist']));
    // The child PATH is the fixed one (plus the test shims), never the parent's.
    const fixed = [
      ...new Set([dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'])
    ].join(':');
    expect(/^PATH=(.*)$/m.exec(text)![1]).toBe(`${shims}:${fixed}`);
    // prlimit really applied (executor defaults or the audio limits).
    expect(readFileSync(`${base}.limits`, 'utf8')).toMatch(/Max cpu time\s+\d+\s+\d+\s+seconds/);
  }
});
