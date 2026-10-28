import { expect, it } from 'vitest';
import { timecode } from './ui';

it('formats timecodes as mm:ss.d', () => {
  expect(timecode(0)).toBe('00:00.0');
  expect(timecode(12345)).toBe('00:12.3');
  expect(timecode(61000)).toBe('01:01.0');
});

it('formats precise timecodes as mm:ss.mmm', async () => {
  const { preciseTimecode } = await import('./ui');
  expect(preciseTimecode(12033.4)).toBe('00:12.033');
  expect(preciseTimecode(61005)).toBe('01:01.005');
});

it('never labels a simulated or image-less evaluation as multimodal', async () => {
  const { confidenceLabel, expertModeLabel } = await import('./ui');
  expect(expertModeLabel('fake', 'multimodal')).toMatch(/^Simulée/);
  expect(expertModeLabel('fake', 'simulated')).toMatch(/^Simulée/);
  expect(expertModeLabel('claude-subscribe', 'text-only')).toMatch(/aucune image/);
  expect(expertModeLabel('claude-subscribe', 'multimodal')).toMatch(/déclarées/);
  expect(expertModeLabel(null, null)).toBe('Non réalisée');
  expect(confidenceLabel('fake', 'simulated', 0.3)).toBe('confiance fixe du simulateur');
  expect(confidenceLabel('anthropic-api', 'multimodal', 0.82)).toMatch(
    /estimée par le modèle : 82 %/
  );
});
