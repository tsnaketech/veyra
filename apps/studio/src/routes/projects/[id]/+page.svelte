<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { formatUsd, frameTimestampMs, sceneAt } from '@veyra/schemas';
  import AudioPanel from '#lib/components/AudioPanel.svelte';
  import ProductionPanel from '#lib/components/ProductionPanel.svelte';
  import FramePlayer from '#lib/components/FramePlayer.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { componentName, summarizeParams } from '#lib/motion.ts';
  import StatusBadge from '#lib/components/StatusBadge.svelte';
  import {
    batchLabels,
    categoryLabels,
    confidenceLabel,
    evaluationStatusLabels,
    expertModeLabel,
    verdictLabels,
    feedbackLabels,
    modeLabels,
    preciseTimecode,
    providerLabels,
    skippedAiReviews,
    timecode
  } from '#lib/ui.ts';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  let chosenId = $state<string | null>(null);
  const revision = $derived(
    data.revisions.find((r) => r.id === chosenId) ?? data.revisions.at(-1) ?? null
  );
  const jobs = $derived(data.jobs.filter((job) => job.revisionId === revision?.id));
  const job = $derived(jobs.at(-1) ?? null);
  const report = $derived(data.reports.filter((r) => r.revisionId === revision?.id).at(-1) ?? null);
  const skippedReviews = $derived(report ? skippedAiReviews(report.checks) : []);
  const resolvedAudio = $derived(
    job?.resolvedConfig.audio as
      | {
          tracks: { trackId: string; startMs: number; endMs: number }[];
          issues: { trackId: string; code: string; message: string }[];
        }
      | undefined
  );
  const audioEvents = $derived(
    data.visualEvents.find((e) => e.revisionId === revision?.id)?.events ?? []
  );
  const checkGroups = ['Mesuré', 'Jugement IA', 'Non réalisé'] as const;
  const checkGroup = (mode: string) =>
    mode === 'deterministic' ? 'Mesuré' : mode === 'not-performed' ? 'Non réalisé' : 'Jugement IA';
  const comments = $derived(data.feedback.filter((f) => f.revisionId === revision?.id));
  const drafts = $derived(comments.filter((f) => f.status === 'draft'));
  const batches = $derived(data.batches.filter((b) => b.sourceRevisionId === revision?.id));
  const producedBy = $derived(data.batches.find((b) => b.resultRevisionId === revision?.id));
  const openBatch = $derived(batches.find((b) => b.status === 'planned') ?? null);
  const plan = $derived(
    openBatch ? (data.plans.find((p) => p.id === openBatch.planId) ?? null) : null
  );
  const evaluation = $derived(
    data.evaluations.filter((e) => e.revisionId === revision?.id).at(-1) ?? null
  );
  const measured = $derived(
    new Map((producedBy?.verification ?? []).map((v) => [v.feedbackId, v.verdict]))
  );
  const sideLabels: Record<string, string> = { before: 'avant', after: 'après' };
  const roleLabels: Record<string, string> = {
    capture: 'capture annotée',
    aligned: 'frame alignée',
    sequence: 'séquence',
    scene: 'scène'
  };
  /** "avant · séquence ×5, après · frame alignée" */
  const evidenceSummary = (items: { revision: string; role: string }[]) => {
    const counts: Record<string, number> = {};
    for (const item of items) {
      const key = `${sideLabels[item.revision]} · ${roleLabels[item.role]}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([key, n]) => (n > 1 ? `${key} ×${n}` : key))
      .join(', ');
  };
  const commentText = (id: string) => data.feedback.find((f) => f.id === id)?.text ?? id;
  const pendingTasks = $derived(data.tasks.filter((t) => t.status === 'awaiting_import'));
  const working = $derived(
    !!data.activity ||
      data.runs.some((r) => r.status === 'running') ||
      data.jobs.some((j) => j.status === 'queued' || j.status === 'running') ||
      data.revisions.some((r) => r.status === 'rendering' || r.status === 'qa') ||
      data.batches.some((b) => b.status === 'queued' || b.status === 'submitted')
  );

  let player = $state<{ seekFrame: (index: number) => void }>();
  let frame = $state(0);
  let tab = $state<'chat' | 'video' | 'review'>('video');
  let editing = $state<string | null>(null);
  let fileName = $state('');
  // Comments selected for the next batch; new drafts are selected by default.
  let unselected = $state<string[]>([]);
  const selected = $derived(drafts.filter((d) => !unselected.includes(d.id)));
  // Regenerated after each successful submission: a resent form reuses the old key.
  let submissionKey = $state(crypto.randomUUID());
  const rate = $derived(
    revision?.media
      ? { num: revision.media.fpsNum, den: revision.media.fpsDen }
      : { num: Math.round(revision?.storyboard.fps ?? 30), den: 1 }
  );
  const nowMs = $derived(frameTimestampMs(frame, rate));
  const scene = $derived(revision ? sceneAt(revision.storyboard, nowMs) : undefined);
  const canCorrect = $derived(revision?.status === 'awaiting_approval' && data.aiKind !== null);

  // Waiting on Claude Code or a human: slower refresh so an automatic import shows up.
  const waiting = $derived(
    pendingTasks.length > 0 || data.runs.some((r) => r.status === 'waiting')
  );

  // Poll only while something is actually running or awaited server-side.
  $effect(() => {
    if (!working && !waiting) return;
    const timer = setInterval(() => invalidateAll(), working ? 1000 : 2000);
    return () => clearInterval(timer);
  });

  function goTo(comment: (typeof comments)[number]) {
    tab = 'video';
    if (comment.frameIndex !== null) player?.seekFrame(comment.frameIndex);
  }
  const tabs = [
    { id: 'chat', label: 'Conversation' },
    { id: 'video', label: 'Vidéo' },
    { id: 'review', label: 'Revue' }
  ] as const;
  const show = (id: typeof tab) => (tab === id ? 'flex' : 'hidden lg:flex');
</script>

<svelte:head><title>{data.project.name} — Veyra Studio</title></svelte:head>

<div class="flex items-center gap-3 border-b border-line px-4 py-2">
  <h1 class="truncate font-semibold">{data.project.name}</h1>
  {#if data.aiKind === 'fake'}
    <span class="badge border-warn/50 text-warn" data-testid="simulated-ai"
      >IA simulée (test) — aucune analyse par un modèle</span
    >
  {:else if data.aiKind === null}
    <a class="badge border-bad/50 text-bad" href={resolve('/settings')}>IA non configurée</a>
  {:else}
    <span class="badge border-line text-muted">{providerLabels[data.aiKind]}</span>
  {/if}
  {#if data.providerChoice}
    <form method="POST" action="?/setProvider" use:enhance class="ml-auto flex items-center gap-1">
      <label class="text-xs text-muted" for="project-provider">Fournisseur du projet</label>
      <select
        id="project-provider"
        name="provider"
        class="rounded border border-line bg-transparent px-1 py-0.5 text-xs"
        value={data.project.aiProvider ?? ''}
        onchange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        <option value="">Par défaut (global)</option>
        {#each data.providerChoice as choice (choice.id)}
          <option
            value={choice.id}
            disabled={!choice.ok && choice.id !== data.project.aiProvider}
            title={choice.reason}
            >{providerLabels[choice.id]}{choice.ok ? '' : ' (indisponible)'}</option
          >
        {/each}
      </select>
    </form>
  {/if}
</div>
{#if data.providerError}
  <p
    role="alert"
    class="mx-4 mt-2 rounded-lg border border-bad/50 bg-bad/10 px-3 py-2 text-sm text-bad"
    data-testid="provider-error"
  >
    {data.providerError}
  </p>
{/if}

<div role="tablist" aria-label="Zones du studio" class="flex border-b border-line lg:hidden">
  {#each tabs as item (item.id)}
    <button
      role="tab"
      aria-selected={tab === item.id}
      class="flex-1 py-2 text-sm text-muted aria-selected:border-b-2 aria-selected:border-cyan aria-selected:text-ink"
      onclick={() => (tab = item.id)}>{item.label}</button
    >
  {/each}
</div>

{#if form?.error}
  <p
    role="alert"
    class="mx-4 mt-2 rounded-lg border border-bad/50 bg-bad/10 px-3 py-2 text-sm text-bad"
  >
    {form.error}
  </p>
{/if}

<div
  class="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(18rem,1fr)_minmax(0,2fr)_minmax(18rem,1fr)]"
>
  <!-- Left: conversation -->
  <section aria-label="Conversation" class="panel min-h-0 min-w-0 flex-col {show('chat')}">
    <ol class="flex-1 space-y-3 overflow-y-auto p-3 text-sm" aria-live="polite">
      {#if data.messages.length === 0}
        <li class="text-muted">
          Décrivez la vidéo à produire, par exemple : « Crée une vidéo de 20 secondes présentant un
          service de création de sites web et d'infogérance pour petites entreprises. »
        </li>
      {/if}
      {#each data.messages as message (message.id)}
        <li
          class="rounded-lg px-3 py-2 [overflow-wrap:anywhere] whitespace-pre-line {message.role ===
          'user'
            ? 'ml-6 bg-violet/20'
            : message.text.startsWith('Échec')
              ? 'border border-bad/50 text-bad'
              : message.role === 'system'
                ? 'text-xs text-muted'
                : 'mr-6 bg-raised'}"
          data-role={message.role}
        >
          {message.text}
        </li>
      {/each}
    </ol>

    <div class="space-y-2 border-t border-line p-3">
      {#each pendingTasks as task (task.id)}
        <div class="rounded-lg border border-violet/40 p-2 text-xs" data-testid="assisted-task">
          <p class="mb-1">
            Résultat Claude Code attendu ({task.kind === 'plan'
              ? 'plan'
              : task.kind === 'evaluation'
                ? 'expertise QA'
                : 'storyboard'}) :
            <code class="break-all">{task.dir}</code>
          </p>
          <p class="mb-1 text-cyan" role="status">
            En attente du résultat de Claude Code — import automatique
          </p>
          {#if task.error}<p class="mb-1 text-bad">{task.error}</p>{/if}
          <form method="POST" action="?/importTask" use:enhance>
            <input type="hidden" name="taskId" value={task.id} />
            <button class="btn">Importer le résultat</button>
          </form>
        </div>
      {/each}
      {#if data.activity}
        <p class="text-sm text-cyan" data-testid="activity" role="status">
          {data.activity.stage === 'planning' ? 'Préparation du plan…' : 'Génération en cours…'}
        </p>
      {/if}
      {#if job && (job.status === 'queued' || job.status === 'running')}
        <div role="status" data-testid="render-progress">
          <p class="mb-1 text-xs text-muted">Rendu : {job.stage} — {job.progress} %</p>
          <div class="h-1.5 overflow-hidden rounded bg-raised">
            <div
              class="h-full bg-linear-to-r from-violet to-cyan transition-all"
              style="width: {job.progress}%"
            ></div>
          </div>
        </div>
      {/if}
      <form method="POST" action="?/prompt" use:enhance class="space-y-2">
        <label for="prompt" class="sr-only">Message à Veyra</label>
        <textarea
          id="prompt"
          name="prompt"
          rows="3"
          class="field resize-none"
          placeholder="Décrivez votre vidéo…"
          required
          disabled={!!data.activity || data.aiKind === null}></textarea>
        {#if data.aiKind === 'anthropic-api' || data.aiKind === 'openai-api'}
          <label for="budgetUsd" class="block text-xs text-muted">Enveloppe autorisée (USD)</label>
          <input
            id="budgetUsd"
            name="budgetUsd"
            type="number"
            min="0"
            max={data.maxBudgetUsd}
            step="0.01"
            value="0"
            class="field"
            aria-describedby="budget-help"
          />
          <p id="budget-help" class="text-xs text-muted">
            {#if data.estimate}Pire cas d'un appel storyboard ({data.estimate.model}) : {formatUsd(
                data.estimate.microUsd
              )} $, calculé depuis la grille tarifaire locale.{:else}Modèle sans tarif local :
              appels refusés.{/if} 0 = aucun appel facturable ; plafond : {data.maxBudgetUsd} $.
          </p>
        {/if}
        <button class="btn btn-primary w-full" disabled={!!data.activity || data.aiKind === null}
          >Envoyer</button
        >
      </form>
      <form
        method="POST"
        action="?/upload"
        enctype="multipart/form-data"
        use:enhance
        class="flex gap-2"
      >
        <!-- Native file input kept for accessibility; its untranslatable button is visually replaced. -->
        <input
          id="file"
          name="file"
          type="file"
          class="peer sr-only"
          required
          onchange={(e) => (fileName = e.currentTarget.files?.[0]?.name ?? '')}
        />
        <label
          for="file"
          class="field flex min-w-0 cursor-pointer items-center gap-2 text-xs peer-focus-visible:outline-2 peer-focus-visible:outline-cyan"
          ><Icon name="file" class="size-4 shrink-0 text-muted" /><span class="truncate"
            >{fileName || 'Choisir un fichier…'}</span
          ></label
        >
        <button class="btn">Ajouter</button>
      </form>
      {#if data.assets.length}
        <ul class="text-xs text-muted">
          {#each data.assets as asset (asset.id)}<li class="flex items-center gap-1">
              <Icon name="file" class="size-3.5 shrink-0" />{asset.name}
            </li>{/each}
        </ul>
      {/if}
    </div>
  </section>

  <!-- Center: player -->
  <section aria-label="Lecteur vidéo" class="min-h-0 min-w-0 flex-col gap-3 {show('video')}">
    {#if revision?.videoPath}
      {#key revision.id}
        <FramePlayer
          bind:this={player}
          bind:frame
          src="/media/{revision.id}"
          media={revision.media}
          storyboard={revision.storyboard}
          markers={comments.map((c) => ({
            id: c.id,
            timestampMs: c.timestampMs,
            frameIndex: c.frameIndex,
            label: `${preciseTimecode(c.timestampMs)} — ${c.text}`
          }))}
        />
      {/key}
      <form
        method="POST"
        action="?/comment"
        class="panel space-y-2 p-3"
        use:enhance={({ formElement }) =>
          async ({ update, result }) => {
            await update({ reset: false });
            if (result.type === 'success') formElement.reset();
          }}
      >
        <input type="hidden" name="revisionId" value={revision.id} />
        <input type="hidden" name="frameIndex" value={frame} />
        <label for="comment" class="text-sm"
          >Commentaire à la frame {frame} ({preciseTimecode(nowMs)})</label
        >
        <textarea
          id="comment"
          name="text"
          rows="2"
          class="field"
          required
          maxlength="2000"
          placeholder="Décrivez la correction attendue sur cette image…"></textarea>
        <label for="range-end" class="block text-sm"
          >Fin de plage (facultatif, mm:ss ou secondes)</label
        >
        <input id="range-end" name="rangeEnd" class="field" placeholder="00:12" />
        <label for="comment-audio-track" class="block text-sm">Piste audio (facultatif)</label>
        <select id="comment-audio-track" name="audioTrackId" class="field"
          ><option value="">Aucune piste ciblée</option
          >{#each revision.audio?.tracks ?? [] as track (track.id)}<option value={track.id}
              >{track.label}</option
            >{/each}</select
        >
        <div class="flex items-center gap-2">
          <button class="btn btn-primary">Ajouter</button>
          <span class="text-xs text-muted"
            >Enregistré localement : rien n'est envoyé à l'IA ni rendu.</span
          >
        </div>
      </form>
    {:else}
      <div class="panel flex aspect-video items-center justify-center overflow-hidden bg-black">
        {#if !revision}
          <p class="p-6 text-center text-muted" data-testid="no-video">
            Projet créé, aucune vidéo pour l’instant.
          </p>
        {:else if revision.status === 'failed'}
          <div class="p-6 text-center text-bad" data-testid="render-failed">
            <p>Échec du rendu.</p>
            <p class="mt-1 text-xs">{revision.error}</p>
            {#if job?.stderrTail}<pre
                class="mt-2 max-h-40 overflow-auto text-left text-xs text-muted">{job.stderrTail}</pre>{/if}
          </div>
        {:else}
          <p class="p-6 text-center text-cyan" role="status">
            {revision.status === 'qa' ? 'Audit qualité en cours…' : 'Rendu en cours…'}
          </p>
        {/if}
      </div>
    {/if}
    {#if revision}
      <div class="panel flex flex-wrap items-center gap-3 p-3 text-sm">
        <StatusBadge status={revision.status} />
        <label class="flex items-center gap-2 text-xs text-muted">
          Version
          <select
            class="field w-auto py-1"
            value={revision.id}
            onchange={(e) => (chosenId = e.currentTarget.value)}
          >
            {#each data.revisions as rev, index (rev.id)}
              <option value={rev.id}>v{index + 1}</option>
            {/each}
          </select>
        </label>
      </div>
    {/if}
  </section>

  <!-- Right: review -->
  <section
    aria-label="Revue"
    class="panel min-h-0 min-w-0 flex-col gap-4 overflow-y-auto p-3 text-sm {show('review')}"
  >
    <ProductionPanel
      run={data.runs.at(-1) ?? null}
      phases={data.phases}
      billable={data.aiKind === 'anthropic-api' || data.aiKind === 'openai-api'}
      maxBudgetUsd={data.maxBudgetUsd}
    />
    <AudioPanel
      assets={data.assets}
      {revision}
      events={audioEvents}
      resolved={resolvedAudio ?? null}
      maxFileBytes={data.audioMaxFileBytes}
      busy={!!data.activity}
    />
    {#if revision}
      <div class="space-y-2">
        <h2 class="font-medium">Actions</h2>
        <div class="flex flex-wrap gap-2">
          {#if revision.status === 'awaiting_approval'}
            <form method="POST" action="?/approve" use:enhance>
              <input type="hidden" name="revisionId" value={revision.id} />
              <button class="btn btn-primary">Valider cette révision</button>
            </form>
          {/if}
          {#if revision.status === 'approved'}
            <a
              class="btn btn-primary"
              href={resolve('/media/[revisionId]?download', { revisionId: revision.id })}
              download
              data-testid="export">Exporter le MP4</a
            >
          {/if}
        </div>
        {#if revision.status === 'awaiting_approval'}
          {#if skippedReviews.length}
            <p class="text-xs text-warn" data-testid="approval-ai-review-skipped">
              Revue IA non effectuée : {skippedReviews.join(' ; ')} Vérifiez le rendu vous-même avant
              de valider.
            </p>
          {/if}
          <p class="text-xs text-muted">Le contrôle qualité ne remplace pas votre validation.</p>
        {/if}
      </div>

      <div data-testid="annotations">
        <h2 class="mb-2 font-medium">Commentaires</h2>
        {#if comments.length === 0}
          <p class="text-xs text-muted">
            Choisissez une image (← → image par image), écrivez votre commentaire puis « Ajouter ».
          </p>
        {/if}
        <ul class="space-y-2">
          {#each comments as comment (comment.id)}
            <li
              class="rounded-lg bg-raised p-2"
              data-testid="comment"
              data-comment-status={comment.status}
            >
              <div class="flex items-start gap-2">
                {#if comment.status === 'draft'}
                  <input
                    type="checkbox"
                    class="size-6 shrink-0 accent-cyan"
                    aria-label="Inclure dans le prochain envoi"
                    checked={!unselected.includes(comment.id)}
                    onchange={(e) =>
                      (unselected = e.currentTarget.checked
                        ? unselected.filter((id) => id !== comment.id)
                        : [...unselected, comment.id])}
                  />
                {/if}
                {#if comment.hasCapture}
                  <img
                    src="/captures/{comment.id}"
                    alt="Frame {comment.frameIndex}"
                    class="h-10 w-16 shrink-0 rounded object-cover"
                    loading="lazy"
                  />
                {/if}
                <div class="min-w-0 flex-1">
                  <button
                    class="inline-flex min-h-6 items-center font-mono text-xs text-cyan hover:underline"
                    onclick={() => goTo(comment)}
                    >{comment.frameIndex !== null
                      ? `Frame ${comment.frameIndex} · `
                      : ''}{preciseTimecode(comment.timestampMs)}</button
                  >
                  {#if comment.rangeEndMs !== null}<span class="text-xs">
                      → {preciseTimecode(comment.rangeEndMs)}</span
                    >{/if}
                  {#if comment.audioTrackId}<span class="text-xs">
                      · {revision.audio?.tracks.find((t) => t.id === comment.audioTrackId)?.label ??
                        comment.audioTrackId}</span
                    >{/if}
                  <span class="text-xs text-muted">· {feedbackLabels[comment.status]}</span>
                  {#if editing === comment.id}
                    <form
                      method="POST"
                      action="?/editComment"
                      class="mt-1 space-y-1"
                      use:enhance={() =>
                        async ({ update, result }) => {
                          await update();
                          if (result.type === 'success') editing = null;
                        }}
                    >
                      <input type="hidden" name="id" value={comment.id} />
                      <label class="sr-only" for="edit-{comment.id}">Modifier le commentaire</label>
                      <textarea
                        id="edit-{comment.id}"
                        name="text"
                        rows="2"
                        class="field text-sm"
                        required>{comment.text}</textarea
                      >
                      <div class="flex gap-2">
                        <button class="btn min-h-6 py-1 text-xs">Enregistrer</button>
                        <button
                          type="button"
                          class="btn min-h-6 py-1 text-xs"
                          onclick={() => (editing = null)}>Annuler</button
                        >
                      </div>
                    </form>
                  {:else}
                    <p class="break-words">{comment.text}</p>
                  {/if}
                  {#if comment.status === 'draft' && editing !== comment.id}
                    <div class="mt-1 flex gap-2 text-xs">
                      <button
                        class="inline-flex min-h-6 items-center text-muted hover:text-ink"
                        onclick={() => (editing = comment.id)}>Modifier</button
                      >
                      <form method="POST" action="?/deleteComment" use:enhance>
                        <input type="hidden" name="id" value={comment.id} />
                        <button class="inline-flex min-h-6 items-center text-muted hover:text-bad"
                          >Supprimer</button
                        >
                      </form>
                    </div>
                  {/if}
                </div>
              </div>
            </li>
          {/each}
        </ul>
        {#if drafts.length}
          <form
            method="POST"
            action="?/submitBatch"
            class="mt-2"
            use:enhance={() =>
              async ({ update, result }) => {
                await update();
                if (result.type === 'success') submissionKey = crypto.randomUUID();
              }}
          >
            <input type="hidden" name="revisionId" value={revision.id} />
            <input type="hidden" name="submissionKey" value={submissionKey} />
            {#each selected as item (item.id)}
              <input type="hidden" name="feedbackIds" value={item.id} />
            {/each}
            <button
              class="btn btn-primary w-full"
              disabled={!selected.length || !canCorrect || !!data.activity}
              >Envoyer les corrections à l'IA ({selected.length})</button
            >
            {#if !canCorrect}
              <p class="mt-1 text-xs text-muted">
                {data.aiKind === null
                  ? 'Choisissez un fournisseur IA dans Paramètres.'
                  : 'Seule une révision en attente de validation peut être corrigée.'}
              </p>
            {/if}
          </form>
        {/if}
      </div>

      {#if batches.length || producedBy}
        <div data-testid="batches">
          <h2 class="mb-1 font-medium">Lots de corrections</h2>
          <ul class="space-y-2">
            {#each producedBy ? [...batches, producedBy] : batches as batch (batch.id)}
              <li
                class="rounded-lg border border-line p-2 text-xs"
                data-batch-status={batch.status}
              >
                <p>
                  {batch.feedbackIds.length} commentaire(s) · {batchLabels[batch.status]} · {batch.provider}
                </p>
                {#if batch.error}<p class="text-bad">{batch.error}</p>{/if}
                {#if batch.verification}
                  <ul class="mt-1 space-y-0.5" data-testid="verification">
                    {#each batch.verification as item (item.feedbackId)}
                      <li>
                        <span class="font-medium">{item.verdict}</span> —
                        <span class="break-all text-muted">{item.evidence}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
                {#if batch.status === 'failed'}
                  <form method="POST" action="?/retryBatch" use:enhance class="mt-1">
                    <input type="hidden" name="batchId" value={batch.id} />
                    <button class="btn min-h-6 py-1 text-xs" disabled={!!data.activity}
                      >Relancer</button
                    >
                  </form>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if plan && openBatch}
        <div class="space-y-2 rounded-lg border border-violet/40 p-3" data-testid="plan">
          <h2 class="font-medium">Plan de correction proposé</h2>
          <p class="text-xs text-muted">{plan.summary}</p>
          <ul class="list-disc space-y-1 pl-4">
            {#each plan.changes as change, index (index)}<li>{change.instruction}</li>{/each}
            {#each plan.audioChanges as change, index (index)}<li>
                Audio : {change.instruction}
              </li>{/each}
          </ul>
          {#if plan.conflicts.length}
            <div
              class="rounded border border-warn/50 p-2 text-xs text-warn"
              data-testid="conflicts"
            >
              {#each plan.conflicts as conflict, index (index)}<p>{conflict.description}</p>{/each}
            </div>
          {/if}
          {#if revision.status === 'awaiting_approval'}
            <div class="flex flex-wrap gap-2">
              <form method="POST" action="?/apply" use:enhance>
                <input type="hidden" name="planId" value={plan.id} />
                <button class="btn btn-primary" disabled={!!data.activity}
                  >Appliquer et générer une révision</button
                >
              </form>
              <form method="POST" action="?/rejectPlan" use:enhance>
                <input type="hidden" name="batchId" value={openBatch.id} />
                <button class="btn" disabled={!!data.activity}>Rejeter le plan</button>
              </form>
            </div>
          {/if}
        </div>
      {/if}

      <div>
        <h2 class="mb-1 font-medium">Scène à {timecode(nowMs)}</h2>
        {#if scene}
          <p>{scene.text}</p>
          <p class="text-xs text-muted">
            {timecode(scene.start)} → {timecode(scene.start + scene.duration)} ·
            {#if scene.component}rythme{:else}entrée {scene.animation.enter} ·{/if}
            {scene.animation.durationMs} ms
          </p>
          {#if scene.component}
            <div class="mt-2 rounded-lg bg-raised p-2 text-xs" data-testid="scene-component">
              <p>
                Composant <span class="font-medium">{componentName(scene.component.id)}</span>
                <span class="text-muted">v{scene.component.version}</span>
              </p>
              <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                {#each summarizeParams(scene.component) as param (param.key)}
                  <dt class="text-muted">{param.key}</dt>
                  <dd class="break-words">{param.value}</dd>
                {/each}
              </dl>
              <p class="mt-1 text-muted">
                Pour le modifier, commentez une frame de cette scène : la correction vise ce
                composant.
              </p>
            </div>
          {/if}
        {:else}<p class="text-xs text-muted">Aucune scène.</p>{/if}
      </div>

      <details class="text-xs" data-testid="composition">
        <summary class="cursor-pointer text-sm font-medium">
          Composition ({revision.storyboard.scenes.filter((s) => s.component).length} composant(s) sur
          {revision.storyboard.scenes.length} scènes)
        </summary>
        <ol class="mt-2 space-y-1">
          {#each revision.storyboard.scenes as item, index (item.id)}
            <li class="flex gap-2" data-component={item.component?.id ?? 'text'}>
              <span class="font-mono text-muted">{index + 1}.</span>
              <span class="min-w-0">
                <span class="font-medium"
                  >{item.component ? componentName(item.component.id) : 'Texte'}</span
                >
                · {timecode(item.start)} · {item.duration / 1000} s —
                <span class="break-words text-muted">{item.text}</span>
              </span>
            </li>
          {/each}
        </ol>
      </details>

      <div data-testid="qa-report">
        <h2 class="mb-1 font-medium">Contrôle qualité</h2>
        {#if !report}
          <p class="text-xs text-muted">
            {revision.status === 'qa' ? 'Audit en cours…' : 'Aucun rapport pour cette révision.'}
          </p>
        {:else}
          {#each skippedReviews as reason, i (i)}
            <p class="mb-2 text-xs" data-testid="ai-review-skipped">
              <span class="badge border-warn/50 text-warn">Revue IA non effectuée</span>
              <span class="text-muted">{reason}</span>
            </p>
          {/each}
          <p class="mb-2 text-xs text-muted">
            {report.checks.filter((c) => c.passed && c.analysisMode !== 'not-performed')
              .length}/{report.checks.filter((c) => c.analysisMode !== 'not-performed').length} contrôles
            réussis ·
            {report.analysisModes.map((m) => modeLabels[m]).join(', ')}
          </p>
          {#each checkGroups as group (group)}
            {#if report.checks.some((c) => checkGroup(c.analysisMode) === group)}
              <h3 class="mt-2 font-medium">{group}</h3>
              <ul class="space-y-1">
                {#each report.checks.filter((c) => checkGroup(c.analysisMode) === group) as check (check.id)}
                  <li class="flex gap-2">
                    <span
                      class={check.analysisMode === 'not-performed'
                        ? 'text-muted'
                        : check.passed
                          ? 'text-ok'
                          : 'text-bad'}
                      >{check.analysisMode === 'not-performed'
                        ? '—'
                        : check.passed
                          ? '✓'
                          : '✗'}</span
                    >
                    <span class="min-w-0">
                      {check.name}
                      <span class="block text-xs break-all text-muted"
                        >{check.evidence} · {modeLabels[check.analysisMode]}</span
                      >
                      {#if !check.passed}<span class="block text-xs text-warn"
                          >{check.recommendation}</span
                        >{/if}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
          {/each}
        {/if}
      </div>
    {/if}

    {#if evaluation || producedBy}
      <div data-testid="expert-qa" class="space-y-3">
        <h2 class="font-medium">Expertise QA des corrections</h2>
        {#if evaluation}
          {@const quality = evaluation.findings.filter((f) => f.kind !== 'regression')}
          {@const expertRegressions = evaluation.findings.filter((f) => f.kind === 'regression')}
          {@const measuredRegressions = (report?.checks ?? []).filter(
            (c) => c.name === 'Régression possible'
          )}
          <p class="text-xs text-muted">
            {evaluation.evaluator ?? 'aucun fournisseur'} · {evaluationStatusLabels[
              evaluation.status
            ]} ·
            <span data-testid="expert-mode"
              >{expertModeLabel(evaluation.evaluator, evaluation.analysisMode)}</span
            >
          </p>
          {#if evaluation.error}<p class="text-xs text-warn">{evaluation.error}</p>{/if}
          {#if evaluation.status === 'completed'}
            <p class="text-xs text-muted" data-testid="confidence-note">
              Les scores de confiance sont des estimations produites par l'évaluateur, pas des
              probabilités garanties.
            </p>
          {/if}

          <section
            data-testid="expert-compliance"
            aria-label="Conformité aux corrections demandées"
          >
            <h3 class="mb-1 text-sm font-medium">1. Conformité aux corrections demandées</h3>
            {#if !evaluation.verdicts.length}
              <p class="text-xs text-muted">Aucun verdict.</p>
            {/if}
            <ul class="space-y-2">
              {#each evaluation.verdicts as verdict (verdict.feedbackId)}
                {@const measure = measured.get(verdict.feedbackId)}
                {@const cited = verdict.evidence.filter((e) => e.image)}
                {@const notSeen = evaluation.provided.filter(
                  (p) =>
                    p.feedbackId === verdict.feedbackId &&
                    !evaluation.imagesExamined.includes(p.file)
                )}
                <li class="rounded-lg bg-raised p-2 text-xs" data-verdict={verdict.verdict}>
                  <p class="text-muted">« {commentText(verdict.feedbackId)} »</p>
                  <p>
                    <span class="font-medium">{verdictLabels[verdict.verdict]}</span> ·
                    {categoryLabels[verdict.category]} ·
                    <span data-testid="confidence"
                      >{confidenceLabel(
                        evaluation.evaluator,
                        evaluation.analysisMode,
                        verdict.confidence
                      )}</span
                    >
                  </p>
                  {#if measure}
                    <p class="text-muted">
                      Mesure (image / audio) : {verdictLabels[measure]}
                      {#if measure !== verdict.verdict}<span class="text-warn">
                          — désaccord, à vérifier</span
                        >{/if}
                    </p>
                  {/if}
                  <p class="text-sm break-words">{verdict.justification}</p>
                  <p class="mt-1 font-medium" data-testid="evidence-used">
                    Preuves citées ({cited.length})
                  </p>
                  {#each verdict.evidence as item, index (index)}
                    <div class="mt-1 flex items-start gap-2">
                      {#if item.image}
                        <img
                          src="/qa-images/{evaluation.id}/{item.image}"
                          alt={item.image}
                          class="h-10 w-16 shrink-0 rounded object-cover"
                          loading="lazy"
                        />
                      {:else}
                        <span class="w-16 shrink-0 text-muted">texte</span>
                      {/if}
                      <span class="break-words text-muted">{item.observation}</span>
                    </div>
                  {/each}
                  {#if !cited.length}
                    <p class="text-warn">Aucune image citée : verdict sans preuve visuelle.</p>
                  {/if}
                  <p class="mt-1 text-muted" data-testid="evidence-unchecked">
                    Preuves fournies non examinées : {notSeen.length}{notSeen.length
                      ? ` (${evidenceSummary(notSeen)})`
                      : ''}
                  </p>
                </li>
              {/each}
            </ul>
          </section>

          <section data-testid="expert-quality" aria-label="Qualité technique et artistique">
            <h3 class="mb-1 text-sm font-medium">2. Qualité technique et artistique globale</h3>
            <p class="text-xs text-muted">
              Mesures : {report
                ? `${report.checks.filter((c) => c.passed).length}/${report.checks.length} contrôles réussis (voir Contrôle qualité)`
                : 'aucun rapport'}.
            </p>
            {#if !quality.length}<p class="text-xs text-muted">Aucun constat de l'expert.</p>{/if}
            <ul class="space-y-1 text-xs">
              {#each quality as finding, index (index)}
                <li data-finding={finding.kind}>
                  <span class="font-medium"
                    >{finding.kind === 'defect' ? 'Défaut' : 'Observation'}</span
                  >
                  · {categoryLabels[finding.category]} · {confidenceLabel(
                    evaluation.evaluator,
                    evaluation.analysisMode,
                    finding.confidence
                  )} —
                  <span class="break-words text-muted">{finding.justification}</span>
                </li>
              {/each}
            </ul>
          </section>

          <section data-testid="expert-regressions" aria-label="Régressions potentielles">
            <h3 class="mb-1 text-sm font-medium">3. Régressions potentielles</h3>
            {#if !measuredRegressions.length && !expertRegressions.length}
              <p class="text-xs text-muted">Aucune régression signalée.</p>
            {/if}
            <ul class="space-y-1 text-xs">
              {#each measuredRegressions as check (check.id)}
                <li>
                  <span class="font-medium">Mesure</span> —
                  <span class="break-words text-muted">{check.evidence}</span>
                </li>
              {/each}
              {#each expertRegressions as finding, index (index)}
                <li data-finding="regression">
                  <span class="font-medium">Expert</span> · {categoryLabels[finding.category]} ·
                  {confidenceLabel(
                    evaluation.evaluator,
                    evaluation.analysisMode,
                    finding.confidence
                  )}
                  —
                  <span class="break-words text-muted">{finding.justification}</span>
                </li>
              {/each}
            </ul>
          </section>
        {:else}
          <p class="text-xs text-muted">Aucune expertise pour cette révision.</p>
        {/if}
        {#if revision?.videoPath && evaluation?.status !== 'awaiting_import' && evaluation?.status !== 'pending'}
          <form method="POST" action="?/evaluate" use:enhance>
            <input type="hidden" name="revisionId" value={revision.id} />
            <button class="btn min-h-6 py-1 text-xs" disabled={!!data.activity}
              >{evaluation ? "Relancer l'expertise" : "Demander l'expertise"}</button
            >
          </form>
        {/if}
        <p class="text-xs text-muted">Avis consultatif : seule votre validation fait foi.</p>
      </div>
    {/if}

    <div>
      <h2 class="mb-1 font-medium">Historique des révisions</h2>
      {#if data.revisions.length === 0}<p class="text-xs text-muted">Aucune révision.</p>{/if}
      <ol class="space-y-1">
        {#each data.revisions as rev, index (rev.id)}
          <li>
            <button
              class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-raised {rev.id ===
              revision?.id
                ? 'bg-raised'
                : ''}"
              onclick={() => (chosenId = rev.id)}
            >
              <span class="font-mono text-xs">v{index + 1}</span>
              <StatusBadge status={rev.status} />
            </button>
          </li>
        {/each}
      </ol>
    </div>
  </section>
</div>
