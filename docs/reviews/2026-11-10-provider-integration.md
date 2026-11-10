# Revue indépendante — intégration des fournisseurs (451dd7c..c5f5b5d)

Date : 2026-11-10. Relecteur indépendant, contexte neuf. Aucun appel réseau, aucun binaire codex/claude réel.

## Vérifications exécutées
- `pnpm test` : EXIT 0, 769 tests (Studio 148, ai 64, schemas 357…). `pnpm check` : 0 erreur. `pnpm lint` : EXIT 0 (relancé ; le 1er échec venait de ma sonde temporaire).
- `pnpm --filter studio test:e2e` : 6/6 (2,4 min), port 4173 libre ensuite.
- Sonde temporaire `apps/studio/src/lib/server/zz-review-probe.test.ts` (copie de production.test.ts + 2 cas), exécutée puis supprimée ; `git status` propre.

## Critères
| # | Verdict | Preuve |
|---|---|---|
| 1 | OK | `studio.ts:1508` watchAssistedTasks (version taille+mtime stable sur 2 passages, échec mémorisé par version, projet occupé = report) ; `readResult` O_NOFOLLOW/fichier régulier/≤1 Mo ; `commit()` transactionnel ; tests `production.test.ts:458,476,522,550,579` ; aucun lancement de Claude ajouté (skill : écrire `result.json` seulement). |
| 2 | OK | fake : E2E 6/6 ; anthropic-api client simulé : `production.test.ts` « reserves the worst case… » (storyboard créé, coût réglé). |
| 3 | OK, avec réserve | `capabilities.ts` (openai/codex/local `prepared`, fake `simulated`), `providerAvailability` + refus serveur `jobs/index.ts:124-127`, radio `disabled` ; `createProvider` lève `ProviderUnavailableError`, aucun repli. Réserve : openai-api « Disponible » une fois tarifé mais inutilisable en production (défaut I1). |
| 4 | OK | `codexEnabled()` lit `app_settings.codexChatgptEnabled` (absent = off) ; `createProvider('codex-chatgpt')` sans options → indisponible, même via `VEYRA_AI_PROVIDER` ; sonde inactive tant que désactivé (`providers.test.ts`). |
| 5 | OK, avec réserve | `index.ts` parse : refus sans meter, countTokens → `reserveBudget` (transaction) → appel `max_tokens` réservé → `settleBudget` ; `maxRetries: 0` ; abort via `stopProduction` (test « aborts the call in flight »). Réserve : défaut I2. |
| 6 | OK | une seule classe `Orchestrator` (`production.ts:82`), seul ajout : pas de nouvel essai sur `BudgetExceededError` ; `evaluation.ts` : type `kind` élargi seulement. |
| 7 | OK | clients SDK simulés, faux binaire codex ; E2E force `VEYRA_AI_PROVIDER=fake`. |
| 8 | KO mineur | TASKS T137–T141 marqués « (non commité) » alors qu'ils sont dans 958e29f/8fa2f11/c5f5b5d ; T140 « Fait » alors qu'openai-api échoue au rendu (I1). D022/D023 conformes au code sinon. |

## Défauts confirmés
**Bloquant** : aucun.

**Important**
- I1 — openai-api inutilisable de bout en bout. `Studio.review` (`studio.ts:1573`) envoie toujours les images des scènes ; `OpenAiProvider.ask` les refuse (`openai.ts:79`) ; l'exception remonte dans `RenderJobRunner` (`runner.ts:339`) et fait échouer le rendu. Idem planRevision avec capture d'annotation (cas normal) et expertise QA. Repro (sonde) : `OpenAiProvider` client simulé, `studio(ai, true, {gpt-test})`, `sendPrompt(…, 5)` → run `failed`, révision `failed`, « openai-api : images refusées… ». Le test existant passe `review=false` et ne voit pas le cas.
- I2 — enveloppe insuffisante pour la revue = rendu perdu. Repro (sonde) : `billed()`, `studio(ai, true)`, `sendPrompt(…, 0.33)` → storyboard payé (27 600 µ$), puis `callFor` refuse la revue (0,32 $ nécessaires) → run et révision `failed`, MP4 et QA déterministe jetés ; « Reprendre » refait tout le rendu. Conforme à la lettre de D022 (« phase en échec ») mais une phase non facturable échoue pour un appel facturable optionnel.

**Mineur**
- M1 — `meter.after` dans `finally` (`index.ts:548`, `openai.ts` finally) : si `settleBudget` lève (run supprimé, « Réservation inconnue »), l'erreur d'origine ou la réponse valide est masquée et la réservation reste bloquée. Non reproduit (exige une défaillance du dépôt).
- M2 — réservations orphelines après arrêt brutal jamais libérées (documenté D022) ; `controllers` (Map par run) jamais purgée.
- M3 — claude-subscribe non sélectionnable sans Claude Code installé et connecté (claude.ai) : changement de comportement assumé (TASKS T139) mais un choix déjà stocké reste actif sans vérification au démarrage (incohérence UI/serveur).
- M4 — codex : prompt passé en argv (visible via `ps` par les autres utilisateurs locaux).

## Soupçons non confirmés
- Borne OpenAI « 1 jeton/octet + 256 » : le rendu interne du schéma strict par OpenAI n'est pas documenté ; non vérifiable hors ligne.
- `callFor` réutilisé : état `reserved` partagé dans la closure ; aucun appelant actuel ne réutilise un même `call` (1 appel par callFor, vérifié aux 4 sites), donc sans effet aujourd'hui.
- Migration 0006 : `migration.test.ts` passe ; absence de dérive du snapshot (`drizzle-kit generate`) non vérifiée (écrirait dans le dépôt).

## Fichiers temporaires
Créés puis supprimés : `apps/studio/src/lib/server/zz-review-probe.test.ts`. Journaux hors dépôt : `/tmp/zz-review-*.log`.
