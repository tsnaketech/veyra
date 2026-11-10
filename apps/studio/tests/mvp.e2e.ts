import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

const prompt =
  "Crée une vidéo de 20 secondes présentant un service de création de sites web et d'infogérance pour petites entreprises.";

test('settings never display secret values', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('ai-provider')).toHaveText(/Simulateur de test/);
  // One card per provider; the environment lock prevents any switch from the UI.
  for (const id of [
    'fake',
    'anthropic-api',
    'claude-subscribe',
    'openai-api',
    'codex-chatgpt',
    'local'
  ])
    await expect(page.getByTestId(`provider-${id}`)).toBeVisible();
  // Nothing prepared or simulated is presented as operational (T139).
  for (const id of ['openai-api', 'codex-chatgpt', 'local'])
    await expect(page.getByTestId(`status-${id}`)).toHaveText(/^Statut : Préparé/);
  await expect(page.getByTestId('status-fake')).toHaveText(/^Statut : Simulé/);
  await expect(page.getByTestId('availability-codex-chatgpt')).toHaveText(
    /Indisponible · Statut contractuel ambigu/
  );
  await expect(page.getByTestId('provider-local').getByRole('radio')).toBeDisabled();
  await expect(page.getByText('Choix imposé par')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Utiliser ce fournisseur' })).toBeDisabled();
  await expect(page.getByText(/Aucun basculement automatique/)).toBeVisible();
  await expect(
    page.getByText('[REDACTED]').or(page.getByText('ANTHROPIC_API_KEY'))
  ).not.toHaveCount(0);
});

test('MVP journey: prompt → real render → QA → timestamped comment → new revision → approval → MP4 export', async ({
  page
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByTestId('empty-projects')).toBeVisible();

  await page.getByLabel('Nom du projet').fill('Démo MVP');
  await page.getByRole('button', { name: 'Nouveau projet' }).click();
  await expect(page).toHaveURL(/\/projects\/prj_/);
  await expect(page.getByTestId('no-video')).toBeVisible();
  await expect(page.getByTestId('simulated-ai')).toBeVisible();

  await page.getByLabel('Message à Veyra').fill(prompt);
  await page.getByRole('button', { name: 'Envoyer' }).click();
  await expect(page.getByText(/\[Simulé\] Storyboard/)).toBeVisible({ timeout: 30_000 });
  const player = page.getByTestId('player');
  await expect(player).toBeVisible({ timeout: 180_000 });
  // The player shows up while QA (video and audio checks) is still running.
  await expect(page.locator('[data-status="awaiting_approval"]').first()).toBeVisible({
    timeout: 90_000
  });

  const qa = page.getByTestId('qa-report');
  await expect(qa).toContainText('Déterministe (ffprobe / ffmpeg)');
  await expect(qa).toContainText('Simulé — aucun modèle');

  // Select frame 360 (12 s at 30 fps) exactly, then step with the keyboard.
  await page.getByTestId('scrubber').fill('360');
  await expect(page.getByTestId('frame-index')).toHaveText('360');
  await page.getByRole('group', { name: /Lecteur vidéo/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('frame-index')).toHaveText('361');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('frame-index')).toHaveText('360');
  await expect(page.getByTestId('frame-info')).toContainText('00:12.000');

  // "Ajouter" only saves the comment: no AI call, no render.
  const jobsBefore = await page.getByTestId('render-progress').count();
  await page
    .getByLabel(/Commentaire à la frame 360/)
    .fill("À 12 secondes, ralentis l'animation du texte.");
  await page.locator('form[action="?/comment"]').getByRole('button', { name: 'Ajouter' }).click();
  const comment = page.getByTestId('comment');
  await expect(comment).toContainText('ralentis');
  await expect(comment).toContainText('Frame 360 · 00:12.000');
  await expect(comment).toHaveAttribute('data-comment-status', 'draft');
  await expect(page.getByRole('img', { name: 'Frame 360' })).toBeVisible();
  await expect(page.getByTestId('marker')).toHaveCount(1);
  expect(await page.getByTestId('render-progress').count()).toBe(jobsBefore);
  await expect(page.getByTestId('plan')).toHaveCount(0);

  await page.getByRole('button', { name: /Envoyer les corrections à l'IA \(1\)/ }).click();
  await expect(page.getByTestId('plan')).toContainText(/Ralentir l'animation \(500 → 800 ms\)/, {
    timeout: 30_000
  });
  await page.getByRole('button', { name: 'Appliquer et générer une révision' }).click();

  await expect(page.getByRole('combobox', { name: 'Version' }).locator('option')).toHaveCount(2);
  await expect(page.locator('[data-status="awaiting_approval"]').first()).toBeVisible({
    timeout: 180_000
  });
  await expect(page.locator('[data-status="changes_requested"]')).toHaveCount(1);
  await expect(player).toBeVisible();
  // Comparative QA ran on the real before/after renders.
  await expect(page.getByTestId('verification')).toContainText('applied');
  // Expert QA with the fake provider is labelled simulated, never multimodal.
  const expert = page.getByTestId('expert-qa');
  await expect(expert.getByTestId('expert-mode')).toHaveText(/^Simulée/);
  await expect(expert).not.toContainText('Multimodale');
  await expect(expert.locator('[data-verdict="applied"]')).toHaveCount(1);
  await expect(expert).toContainText('Avis consultatif');
  for (const section of ['expert-compliance', 'expert-quality', 'expert-regressions'])
    await expect(expert.getByTestId(section)).toBeVisible();
  await expect(expert.getByTestId('confidence').first()).toHaveText('confiance fixe du simulateur');
  await expect(expert.getByTestId('confidence-note')).toContainText(
    'pas des probabilités garanties'
  );
  await expect(expert.getByTestId('evidence-unchecked').first()).toBeVisible();

  await page.getByRole('button', { name: 'Valider cette révision' }).click();
  await expect(page.locator('[data-status="approved"]').first()).toBeVisible();
  await expect(page.getByTestId('comment')).toHaveCount(0); // comments belong to v1

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export').click()
  ]);
  const file = testInfo.outputPath('export.mp4');
  await download.saveAs(file);
  const probe = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_name,width,height',
        '-of',
        'json',
        file
      ],
      {
        encoding: 'utf8'
      }
    )
  );
  expect(Math.abs(Number(probe.format.duration) - 20)).toBeLessThan(0.2);
  expect(probe.streams[0]).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080 });

  await page.goto('/');
  await expect(page.locator('[data-status="approved"]')).toBeVisible();
});

test('mobile layout exposes the studio zones as tabs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('Nom du projet').fill('Mobile');
  await page.getByRole('button', { name: 'Nouveau projet' }).click();
  await expect(page).toHaveURL(/\/projects\/prj_/);
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(3);
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page.getByLabel('Message à Veyra')).toBeVisible();
});

test('Motion Engine: catalogue, SaaS composition, targeted component correction, export', async ({
  page
}, testInfo) => {
  await page.goto('/components');
  const cards = page.getByTestId('motion-component');
  await expect(cards).toHaveCount(5);
  for (const check of await page.getByTestId('preview-check').allTextContents())
    expect(check).toBe('check sans erreur');

  await page.goto('/');
  await page.getByLabel('Nom du projet').fill('Pilot SaaS');
  await page.getByRole('button', { name: 'Nouveau projet' }).click();
  await expect(page).toHaveURL(/\/projects\/prj_/);
  await page
    .getByLabel('Message à Veyra')
    .fill(
      'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.'
    );
  await page.getByRole('button', { name: 'Envoyer' }).click();
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 240_000 });
  await expect(page.locator('[data-status="awaiting_approval"]').first()).toBeVisible();

  const composition = page.getByTestId('composition');
  await composition.locator('summary').click();
  await expect(composition.locator('[data-component]')).toHaveCount(5);
  await expect(composition.locator('[data-component="call-to-action"]')).toBeVisible();
  const qa = page.getByTestId('qa-report');
  await expect(qa).toContainText('Mise en page (marges, débordements)');
  await expect(qa).toContainText('Performance de rendu');
  // T104 rendered-picture checks are listed after a fresh render.
  await expect(qa).toContainText('Photosensibilité (flashs, mesure technique)');
  await expect(qa).toContainText("Contraste mesuré sur l'image rendue");

  // Frame 525 = 17.5 s, inside the CallToAction scene (17–20 s).
  await page.getByTestId('scrubber').fill('525');
  await expect(page.getByTestId('frame-index')).toHaveText('525');
  await expect(page.getByTestId('scene-component')).toContainText('CallToAction');
  await expect(page.getByTestId('scene-component')).toContainText('Essai gratuit 14 jours');
  await page
    .getByLabel(/Commentaire à la frame 525/)
    .fill('Change le bouton en « Démarrer maintenant »');
  await page.locator('form[action="?/comment"]').getByRole('button', { name: 'Ajouter' }).click();
  await expect(page.getByTestId('comment')).toHaveCount(1);
  await page.getByRole('button', { name: /Envoyer les corrections à l'IA \(1\)/ }).click();
  await expect(page.getByTestId('plan')).toContainText(
    'Libellé du bouton : « Démarrer maintenant »',
    { timeout: 30_000 }
  );
  await page.getByRole('button', { name: 'Appliquer et générer une révision' }).click();
  await expect(page.getByTestId('verification')).toContainText('applied', { timeout: 240_000 });

  await page.getByTestId('scrubber').fill('525');
  await expect(page.getByTestId('scene-component')).toContainText('Démarrer maintenant');
  await composition.locator('summary').click();
  await expect(composition.locator('[data-component]')).toHaveCount(5);

  await page.getByRole('button', { name: 'Valider cette révision' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export').click()
  ]);
  const file = testInfo.outputPath('motion.mp4');
  await download.saveAs(file);
  const probe = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file],
      { encoding: 'utf8' }
    )
  );
  expect(Math.abs(Number(probe.format.duration) - 20)).toBeLessThan(0.2);
});

test('audio UI: import, production controls, tracks, range comment and picture reuse', async ({
  page
}, testInfo) => {
  // Non-render waits fail fast on a wrong locator; render waits keep their long timeouts.
  const quick = { timeout: 10_000 };
  const wav = testInfo.outputPath('music.wav');
  execFileSync('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=3',
    '-ac',
    '2',
    wav
  ]);
  await page.goto('/');
  await page.getByLabel('Nom du projet').fill('Bande son', quick);
  await page.getByRole('button', { name: 'Nouveau projet' }).click(quick);
  await expect(page).toHaveURL(/\/projects\/prj_/, quick);
  await page.getByLabel(/Fichier audio \(maximum/).setInputFiles(wav, quick);
  await page.getByLabel('Catégorie du fichier').selectOption('music', quick);
  await page.getByRole('button', { name: 'Importer l’audio' }).click(quick);
  await expect(page.getByTestId('audio-panel')).toContainText('Valide', quick);
  await page.getByLabel('Message à Veyra').fill(prompt, quick);
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click(quick);
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('[data-status="awaiting_approval"]').first()).toBeVisible({
    timeout: 90_000
  });
  const production = page.getByTestId('production-panel');
  await expect(production).toContainText('Validation humaine', quick);
  await production.getByRole('button', { name: 'Arrêter', exact: true }).click(quick);
  await expect(production.locator('[data-status="stopped"]')).toBeVisible(quick);
  await production.getByRole('button', { name: 'Reprendre', exact: true }).click(quick);
  await expect(production.getByRole('button', { name: 'Arrêter', exact: true })).toBeVisible(quick);
  await expect(page.getByTestId('player')).toHaveJSProperty('muted', false, quick);
  await expect(page.getByTestId('player')).toHaveJSProperty('controls', true, quick);
  await expect(page.getByTestId('audio-timeline')).toContainText('music.wav', quick);
  await expect(page.getByTestId('qa-report')).toContainText('Non réalisé', quick);
  await expect(page.getByTestId('qa-report')).toContainText('aucune écoute réelle', quick);
  await page.getByTestId('scrubber').fill('240', quick);
  await page
    .getByLabel(/Commentaire à la frame 240/)
    .fill('Entre 00:08 et 00:12, diminue la musique.', quick);
  await page.getByLabel(/Fin de plage/).fill('00:12', quick);
  await page.getByLabel('Piste audio (facultatif)').selectOption({ label: 'music.wav' }, quick);
  await page
    .locator('form[action="?/comment"]')
    .getByRole('button', { name: 'Ajouter', exact: true })
    .click(quick);
  await expect(page.getByTestId('comment')).toContainText('00:12.000', quick);
  await expect(page.getByTestId('comment')).toContainText('music.wav', quick);
  const before = await page.getByTestId('player').getAttribute('src', quick);
  await page.getByLabel('Gain (dB)', { exact: true }).fill('-24', quick);
  await page.getByLabel('Fichier de la piste').selectOption({ label: 'music.wav' }, quick);
  await page.getByLabel('Catégorie de la piste').selectOption('sfx', quick);
  await page.getByLabel('Ancrage', { exact: true }).selectOption('event', quick);
  await page.getByLabel('Événement', { exact: true }).selectOption({ index: 1 }, quick);
  await page.getByRole('button', { name: 'Ajouter à la composition' }).click(quick);
  await page.getByRole('button', { name: 'Enregistrer la bande son' }).click(quick);
  await expect(page.getByTestId('player')).not.toHaveAttribute('src', before!, { timeout: 90_000 });
  await expect(page.getByTestId('qa-report')).toContainText('Vidéo réutilisée', {
    timeout: 90_000
  });
  await expect(page.getByTestId('audio-panel')).toContainText('-24 dB', quick);
});
