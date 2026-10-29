// Display labels; the state machines themselves live in @veyra/schemas.
export const revisionLabels: Record<string, { label: string; tone: Tone }> = {
  running: { label: 'En cours', tone: 'busy' },
  pending: { label: 'À venir', tone: 'neutral' },
  waiting: { label: 'En attente', tone: 'warn' },
  stopped: { label: 'Arrêtée', tone: 'warn' },
  completed: { label: 'Terminée', tone: 'ok' },
  done: { label: 'Terminée', tone: 'ok' },
  skipped: { label: 'Ignorée', tone: 'neutral' },
  draft: { label: 'Brouillon', tone: 'neutral' },
  rendering: { label: 'Rendu en cours', tone: 'busy' },
  qa: { label: 'Audit qualité en cours', tone: 'busy' },
  awaiting_approval: { label: 'Attente de validation', tone: 'warn' },
  approved: { label: 'Validée', tone: 'ok' },
  changes_requested: { label: 'Révision demandée', tone: 'neutral' },
  published: { label: 'Publiée', tone: 'ok' },
  failed: { label: 'Échec', tone: 'bad' }
};
export const feedbackLabels: Record<string, string> = {
  draft: 'En attente',
  queued: 'Dans un lot',
  submitted: 'Envoyé',
  applied: 'Appliqué',
  rejected: 'Rejeté',
  failed: 'Échec — à relancer'
};
export const batchLabels: Record<string, string> = {
  queued: 'En file',
  submitted: 'Analyse en cours',
  awaiting_import: 'En attente du résultat de Claude Code',
  planned: 'Plan proposé',
  applied: 'Appliqué',
  rejected: 'Rejeté',
  failed: 'Échec'
};
export const verdictLabels: Record<string, string> = {
  applied: 'Appliquée',
  partially_applied: 'Partiellement appliquée',
  not_applied: 'Non appliquée',
  contradicts_request: 'Contraire à la demande',
  unverifiable: 'Non vérifiable'
};
export const categoryLabels: Record<string, string> = {
  technical: 'Défaut technique',
  content: 'Contenu',
  aesthetic: 'Appréciation esthétique'
};
/** Never lets a simulated or measured result read as a real multimodal expertise. */
export function expertModeLabel(evaluator: string | null, mode: string | null) {
  // Defence in depth: the simulator is labelled simulated whatever the stored mode says.
  if (evaluator === 'fake' || mode === 'simulated')
    return 'Simulée (règles sur le storyboard, aucune image analysée)';
  if (mode === 'text-only') return 'Texte seul : aucune image regardée';
  if (mode === 'multimodal')
    return evaluator === 'claude-subscribe'
      ? 'Multimodale — images déclarées examinées par Claude Code (mode assisté)'
      : 'Multimodale — images envoyées au modèle';
  return 'Non réalisée';
}
/** Confidence is the evaluator's own estimate, never a guaranteed probability. */
export function confidenceLabel(evaluator: string | null, mode: string | null, value: number) {
  if (evaluator === 'fake' || mode === 'simulated') return 'confiance fixe du simulateur';
  return `confiance estimée par le modèle : ${Math.round(value * 100)} %`;
}
export const evaluationStatusLabels: Record<string, string> = {
  pending: 'En préparation',
  awaiting_import: 'En attente du résultat de Claude Code',
  completed: 'Terminée',
  failed: 'Échec',
  unavailable: 'Indisponible'
};
export const providerLabels: Record<string, string> = {
  fake: 'Simulateur de test — aucun modèle',
  'anthropic-api': 'Claude par API (clé, facturation API)',
  'claude-subscribe': 'Claude Code — abonnement, mode assisté'
};
export const modeLabels: Record<string, string> = {
  'not-performed': 'Non réalisé',
  deterministic: 'Déterministe (ffprobe / ffmpeg)',
  multimodal: 'Multimodal (images)',
  'text-only': 'Texte seul',
  simulated: 'Simulé — aucun modèle'
};
export type Tone = 'neutral' | 'busy' | 'warn' | 'ok' | 'bad';
export const toneClass: Record<Tone, string> = {
  neutral: 'border-line text-muted',
  busy: 'border-cyan/50 text-cyan',
  warn: 'border-warn/50 text-warn',
  ok: 'border-ok/50 text-ok',
  bad: 'border-bad/50 text-bad'
};

export function timecode(ms: number) {
  const total = Math.max(0, Math.floor(ms / 100));
  const minutes = Math.floor(total / 600);
  const seconds = Math.floor(total / 10) % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${total % 10}`;
}
/** mm:ss.mmm — precise enough to tell frames apart. */
export function preciseTimecode(ms: number) {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor(total / 1000) % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`;
}
export const dateTime = (ms: number) =>
  new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
