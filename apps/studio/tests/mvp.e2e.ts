import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

const prompt =
  "Crée une vidéo de 20 secondes présentant un service de création de sites web et d'infogérance pour petites entreprises.";

test('settings never display secret values', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('ai-provider')).toHaveText(/Simulateur de test/);
  // Three explicit providers; the environment lock prevents any switch from the UI.
  for (const id of ['fake', 'anthropic-api', 'claude-subscribe'])
    await expect(page.getByTestId(`provider-${id}`)).toBeVisible();
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
  await expect(page.locator('[data-status="awaiting_approval"]').first()).toBeVisible();

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
