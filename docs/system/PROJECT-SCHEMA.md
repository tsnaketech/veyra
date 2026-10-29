# Schéma de référence du projet

Implémentations : `packages/schemas/src/index.ts` (validation et types),
`apps/studio/src/lib/server/db/schema.ts` (SQLite), `repo.ts` (opérations métier).

## Entités et relations

| Entité | Identifiant | Champs et relations principaux |
|---|---|---|
| Project | prj_ | Nom, configuration résolue masquée, dates de création et mise à jour |
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
- `0002_quality_evaluations` (D015) : table `quality_evaluations` ; reconstruction
  de `ai_tasks` (CHECK `kind` + `evaluation`), lignes copiées telles quelles.

Attention : le migrateur Drizzle exécute chaque migration dans une transaction,
où `PRAGMA foreign_keys=OFF` est sans effet. La reconstruction de `feedback`
fonctionne parce qu'aucune table ne la référence ; une table référencée
(`video_revisions`, `scenes`) ne peut pas être reconstruite ainsi. Préférer des
changements additifs.

## File de rendu

La file en processus prend les jobs queued et les exécute un par un. La progression
est monotone ; seules les lignes running acceptent une mise à jour de progression.
Le succès du job signifie que rendu et analyse ont terminé, pas que tous les
contrôles QA passent : le rapport reste soumis à revue humaine. Une erreur de
rendu ou d'analyse est persistée sur le job et la révision, qui passe `failed`.
