# Schéma de référence du projet

Implémentations : `packages/schemas/src/index.ts` (validation et types),
`apps/studio/src/lib/server/db/schema.ts` (SQLite), `repo.ts` (opérations métier).

## Entités et relations

| Entité | Identifiant | Champs et relations principaux |
|---|---|---|
| Project | prj_ | Nom, configuration résolue masquée, fournisseur IA du projet nullable (`aiProvider`, D024 ; null = choix global), dates de création et mise à jour |
| Scene | scn_ | Révision, début, durée, texte, paramètres d’animation JSON |
| Asset | ast_ | Projet, chemin fichier, type média, dates |
| Conversation | cnv_ | Projet, dates |
| Message | msg_ | Conversation, rôle user/assistant/system/tool, texte, date |
| VideoRevision | rev_ | Projet, révision parente nullable, état, storyboard JSON, configuration JSON (origine : prompt, plan, lot ou correction auto ; `aiProvider`), chemin vidéo, `media` JSON mesuré (fpsNum/fpsDen, durée, startMs, frameCount, constantFrameRate), erreur, dates |
| RenderJob | rnd_ | Révision, état, progression 0–100, étape, configuration résolue masquée JSON, chemin de sortie, erreur, stderrTail, dates |
| Feedback | fdb_ | Projet, révision, timestampMs, frameIndex / fpsNum / fpsDen (nullables : commentaires antérieurs à 0001), capturePath nullable, batchId nullable, sceneId nullable, texte, état, auteur, dates |
| CorrectionBatch | cbt_ | Projet, révision source (FK composite), submissionKey unique, état, fournisseur, feedbackIds, plan, révision produite, vérification JSON (verdict par commentaire), erreur, dates |
| QualityEvaluation | qev_ | Projet, révision évaluée, révision de base, lot nullable, évaluateur nullable, analysisMode nullable, état, verdicts JSON (commentaire, verdict, catégorie, confiance, justification, preuves), constats JSON, images examinées, erreur, dates |
| AiTask | tsk_ | Projet, type storyboard/plan/evaluation, fournisseur, état, lot nullable, entrée JSON, dossier d'échange, erreur, dates (mode assisté) |
| ProductionRun | run_ | Projet, type production/revision, état, brief, plan Director (`maxAiCalls`, `maxRenders`), révisions source et produite, `aiCalls`, enveloppe de dépense D022 (`budgetMicroUsd`, `spentMicroUsd`, `reservedMicroUsd`, entiers en micro-dollars, 0 par défaut), erreur, dates |
| AppSetting | — | Clé/valeur (`aiProvider` : fournisseur choisi dans /settings) |
| QualityReport | qar_ | Révision, rapport JSON, date |
| QualityCheck / QualityIssue | qck_ / qis_ | Constats imbriqués dans le rapport, pas de table séparée |
| RevisionPlan | pln_ | Révision, feedbackIds, résumé, changements (feedbackId nullable, scène, instruction, patch structuré), conflits, date ; JSON en base |
| Storyboard | — | Scènes ordonnées (texte, ou `component` : id, version, params, style du registre `@veyra/motion`), largeur, hauteur, fps ; JSON de la révision. La table `scenes` n'indexe que temps et texte. |

Les IDs sont préfixés puis générés par UUID. Les dates sont des entiers Unix en
millisecondes. Les débuts, durées et retours utilisent également les millisecondes.
Les intervalles sont `[start, start + duration[` ; `sceneAt` retourne undefined
hors scène. Les scènes ne se chevauchent pas et leurs IDs sont uniques dans un
storyboard. Un même ID de scène peut être conservé entre révisions ; unicité SQL
sur `(id, revision_id)`.

Les FK empêchent les références orphelines. Les FK composites garantissent que
le retour appartient au projet de la révision et que sa scène appartient à cette
révision. Les suppressions référencées sont refusées. Les index couvrent projets,
révisions, conversations et état des jobs. Aucun média n’est stocké en blob.
Les checks SQL contrôlent états, rôles et temps non négatifs ; les autres contrats
sont validés par Zod dans le dépôt métier. Les écritures applicatives doivent
passer par ce dépôt ; une connexion SQL directe n’applique pas les règles métier.

## Machines à états

- RenderJob : queued → running → succeeded | failed | cancelled ; annulation
  également autorisée depuis queued. Les états terminaux n’ont pas de sortie.
- VideoRevision : draft → rendering → qa → awaiting_approval → approved |
  changes_requested ; rendering | qa → failed. changes_requested et failed sont
  terminaux : une correction ou une relance crée une révision enfant
  (`parentRevisionId`), la révision rendue n'est jamais rouverte.
  approved → published est une opération d'état uniquement. Le contenu approuvé
  ou publié est immuable ; published est terminal.
- Feedback : draft → queued → submitted → applied | rejected ; queued | submitted
  → failed → queued (relance). Seul un draft est modifiable ou supprimable
  (suppression physique). applied et rejected sont terminaux.
- CorrectionBatch : queued → submitted | awaiting_import → planned → applied |
  rejected ; queued | submitted | awaiting_import → failed → queued.
- AiTask : awaiting_import → imported | failed.
- QualityEvaluation : pending → awaiting_import | completed | failed | unavailable ;
  awaiting_import → completed | failed. États finaux : une relance crée une nouvelle évaluation.

La création impose draft (révision, retour) ou queued (job, lot). Les transitions sont vérifiées par
`assertTransition` et appliquées en transactions. Une modification de storyboard
qui supprimerait une scène référencée par un retour est refusée et annulée.

## Qualité et plans

Chaque contrôle et problème porte son `analysisMode` obligatoire : deterministic,
multimodal, text-only ou simulated. Ce champ fait autorité pour le constat.
Le rapport contient `analysisModes`, union sans doublon des modes de ses contrôles
et problèmes ; Zod vérifie l’égalité des ensembles (ordre libre). L’utilitaire
`analysisModesFor` dérive une liste triée. Un rapport vide a une liste vide.
Un rapport peut donc mêler ffprobe déterministe et analyse qualitative.
Chaque constat comporte sévérité info/minor/major/critical, timestamp, preuve et
recommandation. Le runner marque explicitement les données FakeEngine `simulated`.

Un plan référence une révision et des retours de cette même révision. Ses
patches (`scenePatchSchema` : texte, durée, entrée, durée d'animation) sont le
seul moyen de modifier un storyboard ; ils s'appliquent à une copie. Le dépôt
vérifie ces liens avant insertion ; les références internes au JSON ne sont pas
des clés étrangères SQL.

## Migrations

Dans `apps/studio/drizzle/` (snapshot et journal), appliquées au démarrage :

- `0000` : schéma initial (fusion des migrations non publiées, D008). Ne plus modifier.
- `0001_frames_and_batches` (D014) : tables `correction_batches`, `ai_tasks`,
  `app_settings` ; `video_revisions.media` ; reconstruction de `feedback` avec
  copie des lignes et des statuts (`open`→`draft`, `planned`→`submitted`,
  `resolved`→`applied`) ; renommage de `aiProvider` (`fake-test-only`→`fake`,
  `anthropic`→`anthropic-api`). Le SQL généré a été corrigé à la main pour la copie.
  Test : `src/lib/server/db/migration.test.ts`.
- `0003_audio` (v0.3) : colonnes ajoutées uniquement — `video_revisions.audio`
  (composition audio JSON, immuable avec la révision), `video_revisions.silent_video_path`,
  `assets.audio` (validation et métadonnées d'un fichier audio), `feedback.range_end_ms`
  (fin de plage, ≥ `timestamp_ms`, vérifiée par le dépôt) et `feedback.audio_track_id`.
- `0006_budget_envelope` (D022) : colonnes ajoutées uniquement —
  `production_runs.budget_micro_usd`, `spent_micro_usd`, `reserved_micro_usd`
  (`integer NOT NULL DEFAULT 0`) ; runs existants conservés, enveloppe 0 (aucun appel
  facturable tant qu'elle n'est pas augmentée). Test : `migration.test.ts` (0005 → 0006).
- `0007_project_ai_provider` (D024) : colonne ajoutée uniquement —
  `projects.ai_provider` (`text`, nullable) ; projets existants à null (choix global).
  Valeurs contrôlées par `aiProviderIdSchema` (Zod) à l'écriture. Test :
  `jobs/providers.test.ts` (base fichier migrée, choix enregistré puis remis à null).
- `0002_quality_evaluations` (D015) : table `quality_evaluations` ; reconstruction
  de `ai_tasks` (CHECK `kind` + `evaluation`), lignes copiées telles quelles.

Attention : le migrateur Drizzle exécute chaque migration dans une transaction,
où `PRAGMA foreign_keys=OFF` est sans effet. La reconstruction de `feedback`
fonctionne parce qu'aucune table ne la référence ; une table référencée
(`video_revisions`, `scenes`) ne peut pas être reconstruite ainsi. Préférer des
changements additifs.

## Enveloppe de dépense (D022)

Un appel facturable n'est possible que dans un run et seulement via le dépôt :
`reserveBudget(runId, pireCas)` vérifie `dépensé + réservé + pireCas ≤ autorisé` et
enregistre la réservation dans la même transaction, **avant** l'appel (sinon
`BudgetExceededError`, message « Budget insuffisant : X $ dépensés, Y $ autorisés,
Z $ nécessaires ») ; `settleBudget(runId, réservation, coûtConstaté | null)` remplace
la réservation par le coût de `response.usage`, ou la garde comme dépensée si le coût
est inconnu (erreur, annulation) ; `raiseBudget` ne fait qu'augmenter l'enveloppe.
`updateRun` n'écrit pas ces colonnes. Une réservation en cours lors d'un arrêt brutal
reste réservée après redémarrage (prudent : elle continue de compter).
Calcul (`packages/schemas/src/production.ts`) : un prix en USD par million de tokens
vaut des micro-dollars par token ; pire cas = entrée × 1,25 × prix d'entrée (tarif
d'écriture en cache, le plus cher) + `max_tokens` × prix de sortie ; coût constaté =
(entrée + 1,25 × écriture cache + 0,1 × lecture cache) × prix d'entrée + sortie × prix
de sortie ; arrondi au micro-dollar supérieur (bruit flottant ignoré). L'exactitude
dépend de la grille tarifaire locale.

## File de rendu

La file en processus prend les jobs queued et les exécute un par un. La progression
est monotone ; seules les lignes running acceptent une mise à jour de progression.
Le succès du job signifie que rendu et analyse ont terminé, pas que tous les
contrôles QA passent : le rapport reste soumis à revue humaine. Une erreur de
rendu ou d'analyse est persistée sur le job et la révision, qui passe `failed`.
