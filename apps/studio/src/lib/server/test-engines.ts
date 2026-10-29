import { createHash } from 'node:crypto';
import { FakeEngine, type CompositionCheck, type VideoEngine } from '@veyra/hyperframes-adapter';
import type { Storyboard } from '@veyra/schemas';
import { probe, runProcess } from '@veyra/video';

/**
 * Test engine producing real H.264 files: one bright solid colour per scene, derived
 * from its text, animation and component. Editing a scene changes its pixels; other
 * scenes stay identical. Used where HyperFrames itself is too slow for unit tests.
 */
export function colorEngine(
  storyboardOf: (revisionId: string) => Storyboard,
  check: (dir: string) => Promise<CompositionCheck> = (dir) => new FakeEngine().check(dir)
): VideoEngine {
  return {
    kind: 'hyperframes',
    validate: (dir) => new FakeEngine().validate(dir),
    preview: (dir) => new FakeEngine().preview(dir),
    async render(_dir, opts) {
      const revisionId = /revisions\/(rev_[^/]+)\//.exec(opts.outputPath)![1];
      const storyboard = storyboardOf(revisionId);
      const inputs = storyboard.scenes.flatMap((scene) => {
        // High bit set on each channel: bright enough never to trip black-frame detection.
        const color = [
          ...createHash('sha1')
            .update(
              `${scene.text}|${JSON.stringify(scene.animation)}|${JSON.stringify(scene.component ?? null)}`
            )
            .digest()
            .subarray(0, 3)
        ]
          .map((byte) => (0x80 | byte).toString(16))
          .join('');
        return [
          '-f',
          'lavfi',
          '-i',
          `color=c=0x${color}:s=${storyboard.width}x${storyboard.height}:r=30:d=${scene.duration / 1000}`
        ];
      });
      await runProcess(
        'ffmpeg',
        [
          '-nostdin',
          '-v',
          'error',
          ...inputs,
          '-filter_complex',
          `concat=n=${storyboard.scenes.length}:v=1:a=0`,
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          opts.outputPath
        ],
        { timeoutMs: 60000 }
      );
      return { path: opts.outputPath, engine: 'hyperframes', stderrTail: '' };
    },
    inspect: (file) => probe(file),
    check
  };
}
