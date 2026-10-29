---
name: video-review
description: Use when changing frame annotations, correction batches, plans or revisions (Studio.addAnnotation, submitBatch, processBatch, importTask, applyPlan, rejectPlan, approve; packages/ai planRevision/applyProposal; FramePlayer).
---

# Annotations, lots de corrections et révisions

Cycle :
1. L'utilisateur choisit une frame (index mesuré, `packages/schemas/src/frames.ts`)
   et clique « Ajouter » → commentaire `draft` persisté avec `frameIndex`,
   `timestampMs`, `fpsNum/fpsDen`, scène, capture PNG exacte. **Aucun appel IA,
   aucun rendu.** Seuls les `draft` sont modifiables ou supprimables.
2. « Envoyer les corrections à l'IA » → `submitBatch` : commentaires sélectionnés,
   même révision source, `submissionKey` unique (idempotent) → lot `queued`,
   commentaires `queued`, puis une seule demande de plan (`submitted`), ou un export
   `awaiting_import` en mode assisté.
3. Plan enregistré (`planned`) avec `feedbackId` par changement et `conflicts`.
   L'utilisateur applique ou rejette.
4. Appliquer → la révision source passe `changes_requested`, une révision enfant
   (`origin.batchId`) est rendue, commentaires `applied`, lot `applied`.
5. Erreur → lot et commentaires `failed`, texte conservé, « Relancer » réutilise le
   même lot et le **même fournisseur** (jamais de substitution).

Scène à composant : `patch.text` = texte principal du composant, `patch.params` =
paramètres fusionnés puis revalidés ; autres composants copiés tels quels.

Invariants :
- Une révision rendue n'est jamais modifiée ; `approved`/`published` sont immuables.
- Les plans ne modifient le storyboard que par `scenePatchSchema` sur des scènes existantes.
- Ids venant d'un modèle ou d'un `result.json` importé : filtrés sur le lot et le storyboard.
- Aucune correction créative sans clic humain ; la validation finale reste humaine.

Référence : [REVIEW-SYSTEM](../../../docs/system/REVIEW-SYSTEM.md).
