import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { visualTimeline } from '@veyra/motion';
import type { Storyboard } from '@veyra/schemas';

const saasPrompt =
  'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.';

const ffmpeg = (args: string[]) =>
  execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', ...args], {
    encoding: 'utf8'
  });

function probe(file: string) {
  return JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_type,codec_name,sample_rate,channels,r_frame_rate,width,height',
        '-of',
        'json',
        file
      ],
      { encoding: 'utf8' }
    )
  ) as {
    format: { duration: string };
    streams: {
      codec_type: string;
      codec_name: string;
      sample_rate?: string;
      r_frame_rate?: string;
    }[];
  };
}

/** md5 of the copied video packets: equal hashes mean the picture was reused bit for bit. */
const videoHash = (file: string) =>
  ffmpeg(['-i', file, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-']).trim();

/** Pop onsets: ends of the silences seen with a threshold above the music bed. */
function onsetsMs(file: string) {
  // silencedetect reports on stderr.
  const { stderr, status } = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-i',
      file,
      '-map',
      '0:a',
      '-af',
      'silencedetect=noise=-12dB:d=0.05',
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8' }
  );
  expect(status).toBe(0);
  return [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]) * 1000);
}

async function download(page: Page, revisionId: string, file: string) {
  const response = await page.request.get(`/media/${revisionId}`);
  expect(response.status()).toBe(200);
  writeFileSync(file, await response.body());
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const currentRevisionId = async (page: Page) =>
  (await page.getByTestId('player').getAttribute('src'))!.replace('/media/', '');

test('audiovisual pipeline on a real HyperFrames render: SFX on visual events, ducking correction, approval', async ({
  page
}, testInfo) => {
  // Non-render waits fail fast; only renders and QA get long timeouts.
  const quick = { timeout: 10_000 };
  const render = { timeout: 240_000 };
  const pop = testInfo.outputPath('pop.wav');
  const music = testInfo.outputPath('music.wav');
  // Loud 80 ms pop and a quiet 3 s bed (looped), so a -12 dB threshold isolates the pops.
  ffmpeg(['-f', 'lavfi', '-i', 'aevalsrc=0.9*sin(2*PI*1000*t):s=48000:d=0.08', '-ac', '2', pop]);
  ffmpeg(['-f', 'lavfi', '-i', 'aevalsrc=0.18*sin(2*PI*220*t):s=48000:d=3', '-ac', '2', music]);

  // (1) Project.
  await page.goto('/');
  await page.getByLabel('Nom du projet').fill('Audiovisuel réel', quick);
  await page.getByRole('button', { name: 'Nouveau projet' }).click(quick);
  await expect(page).toHaveURL(/\/projects\/prj_/, quick);

  // (2) Motion composition rendered by HyperFrames.
  await page.getByLabel('Message à Veyra').fill(saasPrompt, quick);
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click(quick);
  await expect(page.getByTestId('player')).toBeVisible(render);
  await expect(page.locator('[data-status="awaiting_approval"]').first()).toBeVisible(render);
  const composition = page.getByTestId('composition');
  await composition.locator('summary').click(quick);
  await expect(composition.locator('[data-component="feature-cards"]')).toBeVisible(quick);
  const v1 = await currentRevisionId(page);

  // (3) Audio import.
  const panel = page.getByTestId('audio-panel');
  for (const [index, [file, category]] of (
    [
      [pop, 'sfx'],
      [music, 'music']
    ] as const
  ).entries()) {
    await page.getByLabel(/Fichier audio \(maximum/).setInputFiles(file, quick);
    await page.getByLabel('Catégorie du fichier').selectOption(category, quick);
    await page.getByRole('button', { name: 'Importer l’audio' }).click(quick);
    // use:enhance resets the form on success: wait, or the next file is cleared before submit.
    await expect(panel.getByText(/· Valide/)).toHaveCount(index + 1, quick);
  }
  await expect(panel.getByText(/· Valide/)).toHaveCount(2, quick);
  await expect(panel).toContainText('48000 Hz', quick);

  // (4) Music bed from 0 s (looped) and one pop per card-appear event of FeatureCards.
  const addTrack = async (asset: string, category: string, event?: string) => {
    await page.getByLabel('Fichier de la piste').selectOption({ label: asset }, quick);
    await page.getByLabel('Catégorie de la piste').selectOption(category, quick);
    if (event) {
      await page.getByLabel('Ancrage', { exact: true }).selectOption('event', quick);
      await page.getByLabel('Événement', { exact: true }).selectOption({ label: event }, quick);
    } else {
      await page.getByLabel('Ancrage', { exact: true }).selectOption('absolute', quick);
      await page.getByLabel('Début absolu (ms)').fill('0', quick);
    }
    await page.getByRole('button', { name: 'Ajouter à la composition' }).click(quick);
  };
  await addTrack('music.wav', 'music');
  for (const i of [1, 2, 3]) await addTrack('pop.wav', 'sfx', `scène 2 · card-appear #${i}`);
  await expect(panel).toContainText('4 piste(s) dans la composition à enregistrer.', quick);
  await page.getByLabel('Boucler la musique').check(quick);
  await page.getByRole('button', { name: 'Enregistrer la bande son' }).click(quick);
  await expect(page.getByTestId('player')).not.toHaveAttribute('src', `/media/${v1}`, render);
  await expect(page.locator('[data-status="awaiting_approval"]').first()).toBeVisible(render);
  await expect(page.getByTestId('qa-report')).toContainText('Vidéo réutilisée', render);
  const v2 = await currentRevisionId(page);

  // (5)(6) MP4 with sound through the media route, probed and measured.
  const v1File = testInfo.outputPath('v1.mp4');
  const v2File = testInfo.outputPath('v2-audio.mp4');
  await download(page, v1, v1File);
  const v2Sha = await download(page, v2, v2File);
  const p2 = probe(v2File);
  const video = p2.streams.find((s) => s.codec_type === 'video')!;
  const audio = p2.streams.find((s) => s.codec_type === 'audio')!;
  expect(video.codec_name).toBe('h264');
  expect(audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000' });
  expect(Math.abs(Number(p2.format.duration) - 20)).toBeLessThanOrEqual(0.1);
  expect(videoHash(v2File)).toBe(videoHash(v1File));

  const [num, den] = video.r_frame_rate!.split('/').map(Number);
  const db = new Database(join(process.env.VEYRA_E2E_ROOT!, 'e2e.db'), {
    readonly: true,
    fileMustExist: true
  });
  const row = db.prepare('select storyboard from video_revisions where id = ?').get(v2) as {
    storyboard: string;
  };
  db.close();
  const cards = visualTimeline(JSON.parse(row.storyboard) as Storyboard, { num, den })
    .filter((e) => e.name === 'card-appear')
    .map((e) => e.startMs);
  expect(cards).toHaveLength(3);
  const onsets = onsetsMs(v2File);
  const deltas = cards.map((t) => Math.min(...onsets.map((o) => Math.abs(o - t))));
  const evidence = JSON.stringify({ duration: p2.format.duration, audio, cards, onsets, deltas });
  testInfo.annotations.push({ type: 'sync', description: evidence });
  console.log(`sync evidence: ${evidence}`);
  for (const delta of deltas) expect(delta).toBeLessThanOrEqual(40);

  // (7) Range comment on the music track.
  await page.getByTestId('scrubber').fill('240', quick);
  await expect(page.getByTestId('frame-index')).toHaveText('240', quick);
  await page
    .getByLabel(/Commentaire à la frame 240/)
    .fill('Entre 00:08 et 00:12, diminue la musique pour mieux entendre la voix off.', quick);
  await page.getByLabel(/Fin de plage/).fill('00:12', quick);
  await page.getByLabel('Piste audio (facultatif)').selectOption({ label: 'music.wav' }, quick);
  await page
    .locator('form[action="?/comment"]')
    .getByRole('button', { name: 'Ajouter', exact: true })
    .click(quick);
  await expect(page.getByTestId('comment')).toContainText('00:12.000', quick);
  await expect(page.getByTestId('comment')).toContainText('music.wav', quick);

  // (8) Batch → plan routed to an audio change by the simulated provider.
  await page.getByRole('button', { name: /Envoyer les corrections à l'IA \(1\)/ }).click(quick);
  const plan = page.getByTestId('plan');
  await expect(plan).toContainText('Audio : Atténuer « music.wav » de 12 dB entre 8 s et 12 s', {
    timeout: 30_000
  });

  // (9) Apply → v3; v2 stays listed and byte-identical, the picture is reused.
  await page.getByRole('button', { name: 'Appliquer et générer une révision' }).click(quick);
  const versions = page.getByRole('combobox', { name: 'Version' });
  await expect(versions.locator('option')).toHaveCount(3, render);
  await expect(page.getByTestId('verification').locator('.font-medium')).toHaveText(
    'applied',
    render
  );
  await expect(page.locator('[data-status="awaiting_approval"]').first()).toBeVisible(render);
  const v3 = await currentRevisionId(page);
  expect(v3).not.toBe(v2);
  expect(await download(page, v2, testInfo.outputPath('v2-after.mp4'))).toBe(v2Sha);
  const v3File = testInfo.outputPath('v3.mp4');
  await download(page, v3, v3File);
  expect(videoHash(v3File)).toBe(videoHash(v2File));
  await versions.selectOption({ label: 'v2' }, quick);
  await expect(page.getByTestId('player')).toHaveAttribute('src', `/media/${v2}`, quick);
  await expect(page.locator('[data-status="changes_requested"]').first()).toBeVisible(quick);
  await versions.selectOption({ label: 'v3' }, quick);
  await expect(page.getByTestId('player')).toHaveAttribute('src', `/media/${v3}`, quick);

  // (10) Measured QA, listening not performed, audio verdict with its measurement.
  const qa = page.getByTestId('qa-report');
  await expect(qa.getByRole('heading', { name: 'Mesuré', exact: true })).toBeVisible(quick);
  await expect(qa.getByRole('heading', { name: 'Non réalisé', exact: true })).toBeVisible(quick);
  await expect(qa).toContainText('Écoute qualitative', quick);
  await expect(qa).toContainText('Correction 1 — appliquée', quick);
  const verification = page.getByTestId('verification');
  await expect(verification).toContainText(/Mesuré sur le mix, 8000–12000 ms/, quick);

  // (11) Human approval completes the production run; the export carries the sound.
  const production = page.getByTestId('production-panel');
  // Approve once the run waits for the human: an approval given while the expert QA of the
  // render phase is still running is not recorded on the run (race reported, not fixed here).
  await expect(production).toContainText('Phase en cours : Validation humaine', {
    timeout: 30_000
  });
  await expect(production.locator('[data-status="waiting"]').first()).toBeVisible(quick);
  await page.getByRole('button', { name: 'Valider cette révision' }).click(quick);
  await expect(page.locator('[data-status="approved"]').first()).toBeVisible(quick);
  await expect(production.locator('[data-status="completed"]').first()).toBeVisible(quick);
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export').click()
  ]);
  const exported = testInfo.outputPath('demo-audio.mp4');
  await file.saveAs(exported);
  const p3 = probe(exported);
  expect(p3.streams.find((s) => s.codec_type === 'audio')).toMatchObject({
    codec_name: 'aac',
    sample_rate: '48000'
  });
  expect(Math.abs(Number(p3.format.duration) - 20)).toBeLessThanOrEqual(0.1);
});
