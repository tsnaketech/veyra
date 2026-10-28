---
name: prompt-to-video
description: Use when changing how a user prompt becomes a Veyra storyboard (packages/ai generateStoryboard, toStoryboard, Studio.sendPrompt).
---

# Prompt → storyboard

Flux : `Studio.sendPrompt` → `AiProvider.generateStoryboard` → `toStoryboard` → révision `draft` → rendu.

Règles :
- Le modèle ne produit que `storyboardDraftSchema` (texte ≤ 140 car., durée, entrée, durée d'animation). Jamais de HTML, CSS ou JS : la composition est générée par `compose()` dans `packages/hyperframes-adapter`.
- Durée totale ≤ `maxDurationSeconds` (config/app.yaml, 60 s). Format par défaut : `formats.yaml` → `landscape`.
- Toute sortie du `FakeAiProvider` est préfixée « [Simulé] » côté Studio. Ne jamais présenter une sortie simulée comme une analyse réelle.
- Revalider avec Zod après l'appel au modèle : le format de sortie ne porte pas toutes les bornes.

Vérifier : `pnpm --filter @veyra/ai test`, puis le parcours `apps/studio/tests/mvp.e2e.ts`.
Référence : [AGENT-WORKFLOWS](../../../docs/ai/AGENT-WORKFLOWS.md).
