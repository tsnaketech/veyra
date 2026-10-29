---
name: prompt-to-video
description: Use when changing how a user prompt becomes a Veyra storyboard or motion composition (packages/ai generateStoryboard, toStoryboard, applyProposal, Studio.sendPrompt; packages/motion registry).
---

# Prompt → storyboard

Flux : `Studio.sendPrompt` → `AiProvider.generateStoryboard` → `toStoryboard` → révision `draft` → rendu.

Règles :
- Le modèle ne produit que `storyboardDraftSchema` : par scène, un texte (≤ 140 car.) ou un `component` du registre `@veyra/motion` (union discriminée Zod, durée vérifiée par `checkTiming`). Jamais de HTML, CSS ou JS : la composition est générée par `compose()` ; les composants ne livrent que du HTML échappé et des animations en données.
- Nouveau composant : voir [MOTION-ENGINE](../../../docs/video/MOTION-ENGINE.md) ; il n'est fonctionnel qu'après un aperçu réel sans erreur (`pnpm motion:previews`).
- Durée totale ≤ `maxDurationSeconds` (config/app.yaml, 60 s). Format par défaut : `formats.yaml` → `landscape`.
- Toute sortie du `FakeAiProvider` est préfixée « [Simulé] » côté Studio. Ne jamais présenter une sortie simulée comme une analyse réelle.
- Revalider avec Zod après l'appel au modèle : le format de sortie ne porte pas toutes les bornes.

Vérifier : `pnpm --filter @veyra/ai test`, puis le parcours `apps/studio/tests/mvp.e2e.ts`.
Référence : [AGENT-WORKFLOWS](../../../docs/ai/AGENT-WORKFLOWS.md).
