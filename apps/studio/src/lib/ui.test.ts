import { expect, it } from 'vitest';
import { skippedAiReviews } from './ui';

it('lists unperformed AI reviews with their reason, never as passed checks (T146)', () => {
  const checks = [
    { analysisMode: 'deterministic', evidence: 'Durée 20 s', passed: true },
    {
      analysisMode: 'not-performed',
      evidence: 'Revue IA non effectuée : Budget insuffisant',
      passed: false
    },
    // A measurement that could not run is not an AI review.
    { analysisMode: 'not-performed', evidence: 'Mesure audio impossible', passed: false }
  ];
  expect(skippedAiReviews(checks)).toEqual(['Budget insuffisant']);
  expect(skippedAiReviews(checks.slice(0, 1))).toEqual([]);
});
