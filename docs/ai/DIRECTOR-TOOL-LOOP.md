# Boucle d'outils bornée du Director (architecture, T129)

Statut : architecture **acceptée le 2026-11-11** (D021) ; moteur de pas **sans IA
implémenté le 2026-11-11** (T129a, § 9) ; **source de pas IA et Director simulé** (T129b-1,
§ 10) ; **Director dans le Studio** (T129b-2, § 11 : point d'entrée dans le chat, routes de
décision, affichage des pas) ; affichage avancé (T129c) à faire. Décisions :
D021 (acceptée) et [D026](../DECISIONS.md#d026--boucle-doutils-t129a--pas-persistés-et-pause-par-action)
dans [DECISIONS](../DECISIONS.md). Outils : [TOOL-REGISTRY](TOOL-REGISTRY.md).
Agents : [AGENT-ARCHITECTURE](AGENT-ARCHITECTURE.md).

## 1. Ce qui ne change pas

- **D007 tient** : chaque décision du Director est une **donnée structurée validée**
  (sortie structurée de l'API Messages, `messages.parse` + Zod). Pas de Claude Agent
  SDK, aucun outil système (fichiers, shell) donné au modèle.
- **D019 tient** : orchestrateur unique par processus Studio, état dans SQLite,
  enveloppes validées. La boucle s'exécute **dans une phase** d'un run existant.
- QA Expert hors de la boucle (indépendance) ; validation humaine finale obligatoire ;
  révisions immuables.

## 2. Ce qui change

Le Director n'est plus limité à un enchaînement de phases prédéfini : à chaque **pas**,
il voit l'état (plan courant, résultats observés, budget restant) et propose **une**
action typée. Le moteur la vérifie, l'exécute si elle est permise, et lui renvoie
l'observation réelle.

```text
            ┌────────────────────────── budget, historique, plan courant
            ▼
   Director (1 appel structuré) ──► DirectorStep
            ▲                          │
            │                          ▼
            │              Validation Zod (descripteur de l'outil)
            │                          │ refus → observation « invalide »
            │                          ▼
            │              Permissions + budget (§ 4)
            │                          │ payant / réseau / code généré → pause
            │                          │   « en attente de confirmation de cette action »
            │                          ▼
            │              Exécuteur (TOOL-REGISTRY, exécuteur unique T132)
            │                          │
            └──── observation ◄────────┘  (résultat, erreurs structurées, artefacts sha256)
```

Actions possibles d'un pas :

| Action | Effet |
|---|---|
| `tool_call { toolId, toolVersion, input }` | Appel d'un outil inscrit au registre |
| `revise_plan { plan }` | Nouveau `ProductionPlan` (scènes, techniques, outils prévus) ; validé, versionné |
| `request_approval { summary, revisionId }` | Fin de production : révision prête pour l'humain |
| `ask_user { question }` | Blocage créatif ou outil indisponible sans alternative (ex. aucune voix) |
| `stop { reason }` | Abandon explicite, avec raison |

Chaque pas porte une **justification courte** (journal des décisions, affichée), pas
le raisonnement complet du modèle.

## 3. Contrats (à créer en T129, sur les contrats existants)

- `DirectorStep` : union discriminée ci-dessus ; `input` validé ensuite par le schéma
  du descripteur (double validation : forme de l'action, puis entrée de l'outil).
- `ToolInvocation` / `ToolResult` : enveloppe `agentResultSchema` + `toolId`,
  `toolVersion`, `inputHash`, `durationMs`, `cost`, `artefacts[] {kind, path relatif,
  sha256}`, `simulated`, `error {code, message, retryable}`.
- `LoopState` : `{ runId, phaseId, step, status, budgetUsed, plan, history[] }`,
  persisté **après chaque transition** (même modèle que les phases D019).
- Erreurs structurées : `invalid-input`, `permission-denied`, `needs-confirmation`,
  `unavailable` (avec `installHint`), `budget-exhausted`, `timeout`, `failed`,
  `interrupted`.

## 4. Bornes et garde-fous

| Borne | Valeur initiale proposée | Effet au dépassement |
|---|---|---|
| Pas du Director | 20 par run | `stop` forcé, état conservé |
| Appels d'outils | 40 par run | idem |
| Appels IA facturables | `maxAiCalls` (D019) — chaque pas compte | refus **avant** l'appel |
| Rendus | `maxRenders` | `budget-exhausted` |
| Temps mural | 30 min par run ; délai propre à chaque outil | `timeout`, observation renvoyée |
| CPU, mémoire, sorties | limites de l'exécuteur (prlimit, bwrap) | `failed` |
| Échecs consécutifs | 3 ; appel identique en échec répété 2 fois | `stop` avec diagnostic |
| Coût en dollars | **0 par défaut** ; enveloppe par run (D022, T138) | appel IA : refus **avant** l'appel au-delà de l'enveloppe ; autre action `billable` : confirmation **de cette action** |

Permissions par classe (TOOL-REGISTRY § 4) : `read-only` et `local-compute` exécutés
directement ; `writes-revision-artefacts` uniquement dans la révision brouillon du run ;
`network-external`, `billable`, `generated-code-execution` : pause et confirmation
humaine explicite **de cette action** (outil, cible, données sortantes, coût estimé),
jamais d'autorisation implicite ou globale par défaut.

Injection : les observations (sorties d'outils, transcriptions, métadonnées de média,
commentaires) sont transmises au Director **encapsulées et marquées non fiables** ;
elles ne peuvent pas ajouter d'outil à la liste permise ni changer les bornes.

## 5. Reprise après interruption

- Transitions d'un appel : `proposed → authorized → running → done | failed`.
- Au redémarrage : un appel `running` devient `interrupted` ; il n'est rejoué
  automatiquement que si le descripteur le déclare `deterministic` et sans effet externe
  (son `inputHash` et ses artefacts permettent de vérifier qu'il n'a rien laissé
  d'incomplet) ; sinon le Director reçoit l'observation `interrupted` et décide.
- Une confirmation humaine en attente survit au redémarrage (état persisté).
- Les artefacts d'un appel interrompu sont dans un dossier d'appel jamais réutilisé tel
  quel (écriture temporaire puis renommage, comme les rendus actuels).

## 6. Traçabilité

Chaque appel relie : demande (prompt, commentaire, lot) → run → pas → agent → outil
(id, version) → scène/média → révision → artefacts (sha256) → résultat validé ou erreur.
Affichage Studio : liste des pas, justification, outil, durée, coût, état ; les sorties
simulées restent marquées « [Simulé] ».

## 7. Fournisseurs

- `anthropic-api` : un appel structuré par pas, compté dans le budget.
- `fake` : Director simulé déterministe (règles), étiqueté ; ne prouve aucune capacité IA.
- `claude-subscribe` (D010) : pas d'automatisation ; un pas = une tâche exportée/importée
  par l'utilisateur, ou plan complet en une tâche (mode actuel). Jamais `claude -p`
  lancé par le serveur ni bascule silencieuse vers l'API.

## 8. Étapes d'implémentation (après T127)

1. **T128** : `EditOperation` (union typée : scène, animation, média, audio, sous-titres,
   transition, durée) + graphe d'invalidation des artefacts ; exécuteur `revision.apply`.
2. **T129a** : contrats `DirectorStep`, `ToolInvocation`, `ToolResult`, `LoopState` ;
   migration additive `tool_calls` ; moteur de pas **sans IA** (plan scripté) pour tester
   bornes, permissions, reprise.
3. **T129b** : Director `fake` puis `anthropic-api` derrière le moteur de pas ; tests :
   brief contrasté → outils différents, outil indisponible → `ask_user`, action payante →
   pause.
4. **T129c** : affichage Studio des pas et des confirmations.

## 9. Implémentation T129a (2026-11-11)

Moteur de pas sans IA ; la source de pas est injectable (`StepSource.next(view)`), scriptée
dans les tests ; un Director la remplacera en T129b sans changer le moteur.

- **Contrats** (`packages/schemas/src/loop.ts`) : `directorStepSchema` (`tool_call`,
  `request_permission`, `request_approval`, `stop` ; `revise_plan` et `ask_user` reportés
  à T129b), `toolInvocationSchema` (champs `agent`/`phase` de `agentResultSchema`, `grants`
  de cet appel seul), `toolExecutionRecordSchema` (ligne persistée), `loopLimitsSchema`
  (20 pas, 40 appels, 3 échecs consécutifs, 16 Kio par résultat), `loopStateSchema`,
  `toolLoopOutcomeSchema` (payload de la phase). Codes d'erreur ajoutés : `cancelled`,
  `interrupted` ; `ToolResult.cost { kind, microUsd }` déclaré.
- **Exécution dans un run** : `toolLoopRunner(...)` (`apps/studio/src/lib/server/tool-loop.ts`)
  est le `PhaseRunner` d'une phase (par défaut `plan`, agent `director`) d'un run `revision`
  piloté par l'`Orchestrator` existant ; son résultat est une enveloppe `agentResultSchema`
  validée (`toolLoopOutcomeSchema` ajouté à l'union du payload `plan`). Tout appel passe
  par `registry.invoke` (validation, permissions, disponibilité, délai, sortie).
- **Persistance** : table additive `loop_steps` (migration 0008), une ligne par pas, écrite
  avant et après l'appel ; `loopState()` est dérivé de ces lignes (aucun état en mémoire).
- **Pause** : un outil `billable` ou `network-external`, ou `request_permission`, crée un pas
  `awaiting-permission` et la phase passe `waiting`, même si la classe figure dans les
  `grants` de la phase. `decidePermission(repo, phaseId, stepId, accordé)` puis
  `Orchestrator.wake(runId, phase, runners)` (transition `waiting → pending`, tentatives
  remises à 0). Une action refusée (même outil, même `inputHash`) n'est **jamais** exécutée,
  même redemandée. `generated-code-execution` n'est jamais accordable, ni par l'humain ni
  par les `grants` de la phase (T148).
- **Bornes** : pas, appels, échecs consécutifs, appel identique en échec répété deux fois →
  pas `stop` d'origine `engine`, phase en échec, état conservé. Délai par outil : le registre
  avorte `ctx.signal`, ce qui tue le groupe de processus (`runProcess`). Limites prlimit par
  outil : `limits.cpuSeconds`, `limits.memoryBytes` → `ctx.processLimits`.
- **Annulation** : `signal` du runner propagé jusqu'au processus ; pas `cancelled`, phase en
  échec. Un outil qui n'a pas rendu la main (signal ignoré) est signalé « effet
  possiblement en cours » et tout nouvel appel du même outil est refusé tant qu'il tourne
  (T148). Une annulation pendant `source.next` n'écrit aucun pas. **Reprise** : au
  redémarrage, un pas `running` est rejoué seulement si l'outil est `deterministic`,
  `sideEffects: none` et ni `billable` ni `network-external`, sinon `interrupted` et
  observation à la source ; les pas terminés ne sont jamais rejoués.
- **Approbation** : `request_approval` n'accepte que la révision source du run ou une
  révision produite par la boucle (T148).
- **Pas encore** : aucune route ni interface (T129c) ; aucune source IA (T129b) ; budget
  `maxAiCalls`/enveloppe D022 non débité par un outil `billable` (coût déclaré seulement) ;
  pas de délai mural global de 30 min ; `revise_plan`/`ask_user` non implémentés.

Preuves : `apps/studio/src/lib/server/tool-loop.test.ts`, `tool-loop.slow.test.ts`,
`packages/schemas/src/loop.test.ts`, `tools/registry.test.ts` ; détail dans
[TASKS](../TASKS.md) (T129a).

## 10. Implémentation T129b-1 (2026-11-11)

Sécurité, annulation et source de pas IA, sans changer l'orchestrateur ni le registre.

- **Contrats** (`packages/schemas/src/loop.ts`) : actions `revise_plan { plan { goal,
  steps[] } }` et `ask_user { question }` ajoutées à `directorStepSchema` ; `LoopState.plan`
  et statut `paused-awaiting-answer` ; `loopLimits.maxWallMs` (30 min).
- **Fournisseurs** (`packages/ai/src/director.ts`) : `decideStep(view, call)` →
  `DirectorStep`. Le modèle répond au schéma « fil » `directorDecisionSchema` : objet racine,
  union discriminée (`anyOf` après `strictSchema`, aucun `oneOf`), entrée d'outil en texte
  JSON (`inputJson`) car un objet JSON libre n'est pas exprimable en sortie stricte ;
  `decisionToStep` convertit puis valide par `directorStepSchema`, sinon
  `DirectorOutputError`. Même prompt pour `anthropic-api` (`messages.parse`), `openai-api`
  et `codex-chatgpt` (chemin `ask` de `StructuredProvider`). Capacité `director`
  déclarée : vraie pour `fake` (simulé), `anthropic-api`, `openai-api`, `codex-chatgpt` ;
  fausse pour `claude-subscribe` (mode assisté D010, non pris en charge en T129b) et
  `local` (préparé, rien d'implémenté).
- **Prompt** : objectif de l'utilisateur, budget restant, plan, catalogue du registre
  (schémas JSON des outils disponibles ; outils indisponibles avec leur raison), état du
  projet (révision courante résumée), 20 derniers pas. L'objectif, l'état du projet, le
  plan et chaque observation sont dans des blocs `<donnees_non_fiables>` : `<` et `>` y sont
  échappés (le contenu ne peut pas fermer le bloc), 4 000 octets au plus par bloc. Les
  permissions ne dépendent jamais de ce contenu (elles viennent des métadonnées du
  registre et des décisions humaines persistées).
- **Director simulé** (`fake`) : `simulatedDecision(view)`, règles déterministes étiquetées
  « [Simulé] Director » qui lisent les observations : plan initial, outil choisi d'après les
  mots de l'objectif, entrée corrigée d'après les bornes du schéma de l'outil après un
  `invalid-input`, `ask_user` si l'outil est indisponible, `stop` après un refus humain,
  `request_approval` de la révision produite. Ne prouve aucune capacité IA.
- **Studio** : `Studio.directorSource(runId, goal)` construit la source de pas avec le
  fournisseur effectif du projet (aucune substitution ; refus explicite sans capacité
  `director`). Chaque décision compte dans `maxAiCalls` (refus avant l'appel) et passe par
  `callFor` : réservation D022 avant la requête pour un fournisseur facturable, signal
  d'annulation de « Arrêter » (Codex compris), combiné au signal de la boucle.
- **Boucle** (`tool-loop.ts`) : vue `LoopView.tools` = `registry.catalog()` (disponibilité
  réelle) ; `directorView`/`directorStepSource` ; `answerQuestion` ; erreurs de source
  observées et bornées (§ D026, mise à jour T129b-1) ; délai mural global ; appel identique
  trois fois de suite → `stop`.
- **`audio.track.update`** : la file de rendu ne s'interrompt pas en cours de travail
  (raccourci signalé dans le code). À l'annulation ou au délai, le run de révision est
  arrêté entre phases ; une fois son travail terminé, toute révision enfant de ce run en
  `awaiting_approval` passe `changes_requested` (jamais validable) ; le résultat du pas le
  dit (`abortNote` du registre). La révision source garde son contenu ; son statut restait
  `changes_requested` (flux `reviseAudio` de l'interface) jusqu'à T129b-3 : dans une boucle,
  elle reste désormais validable (§ 12).
- **Pas encore** : création du run de boucle par le Studio sur son orchestrateur, `grants`
  depuis le plan validé, routes `decidePermission`/`answerQuestion` + `wake` (T129b-2) ;
  affichage (T129c) ; décompte `maxRenders` dans la boucle ; débit D022 d'un outil
  `billable` réel ; délai mural cumulé entre redémarrages (il vaut par exécution) ;
  aucun appel IA réel du Director (fournisseurs testés avec client et binaire simulés).

Preuves : `packages/ai/src/director.test.ts`, `apps/studio/src/lib/server/director-loop.test.ts`,
`packages/schemas/src/loop.test.ts` ; détail dans [TASKS](../TASKS.md) (T129b-1).

## 11. Implémentation T129b-2 (2026-11-11)

Le Director dans le Studio, sur l'orchestrateur unique, sans migration ni nouveau chat.

- **Point d'entrée** (`Studio.sendPrompt`) : dans le chat d'un projet qui a une révision
  `awaiting_approval` (la plus récente), un message est une demande de montage si le
  fournisseur effectif du projet a la capacité `director` (`fake` simulé, `anthropic-api`,
  `openai-api`, `codex-chatgpt`). Sinon (`claude-subscribe`, `local`) : comportement
  antérieur (nouvelle vidéo), annoncé par un message système ; aucune substitution de
  fournisseur. La case « Produire une nouvelle vidéo » (`fresh`) force l'ancien
  comportement. Un second montage est refusé tant que la boucle d'un Director du projet
  n'est pas terminée (une attente de validation humaine seule ne bloque pas).
- **Run** : `kind: 'revision'`, plan `planDirectorRevision` (`packages/ai/src/agents.ts`) :
  `plan` (agent `director`, `toolLoopRunner` + `studio.directorSource(runId, brief.prompt)`)
  → `render` → `qa` → `human-approval`, toutes trois étapes fixes. `maxAiCalls` = 20 (un
  appel par pas), `maxRenders` = budget de production habituel. Le but est `brief.prompt`
  (persisté : reprise possible). Les runners sont reconstruits à chaque exécution
  (`directorRunners`) : fournisseur courant du projet, refus clair sans capacité.
- **Grants** : `directorGrants(plan)` — `read-only`, `local-compute`, et
  `writes-revision-artefacts` seulement si le plan rend et attend une validation humaine.
  `billable`/`network-external` : pause par action ; code généré : jamais.
- **Suite du run** : la révision désignée par `request_approval` (enfant `draft` de
  `revision.apply`) est rendue par le runner de rendu existant (moteur configuré,
  auto-correction technique, revue IA du runner si disponible), puis QA déterministe,
  puis attente de la validation humaine. Une révision déjà rendue (révision source
  inchangée, ou enfant de `audio.track.update` rendu par son propre run) est réutilisée
  (`status: 'reused'`). `maxRenders` compte aussi les rendus des révisions produites par la
  boucle (`loopRevisions`). L'expertise QA (`requestEvaluation`) exige un plan de
  correction : elle n'est pas lancée pour un enfant du Director.
- **Sort du parent** : jusqu'à T129b-3, le parent passait `changes_requested` dès que
  l'enfant rendu était validable (`supersede`). Remplacé par la règle du § 12 : le parent
  reste validable jusqu'à la validation de l'enfant. Rendu en échec : le parent reste
  validable (mais garde son enfant `failed`, ce qui fait refuser un nouveau `revision.apply`
  sur lui).
- **Décisions humaines** : `Studio.decideDirector(runId, stepId, accordé)` et
  `Studio.answerDirector(runId, stepId, texte)` → `decidePermission`/`answerQuestion` puis
  `Orchestrator.wake`. Run arrêté : la décision est gardée, « Reprendre » continue.
  « Arrêter » : `stopProduction` (signal de la boucle, processus tués), reprise par
  `resumeProduction`. Actions de page `?/decideDirector` (`decision=grant|deny`) et
  `?/answerDirector`, run vérifié comme appartenant au projet ; CSRF : garde globale.
- **Affichage** : `DirectorPanel.svelte` (page projet, colonne Revue) — par run : fournisseur
  (« [Simulé] » pour `fake`), demande, chaque pas (badge « Décision du modèle » ou « Arrêt
  imposé par la boucle »), justification, outil et arguments résumés, résultat ou erreur
  (tronqués), boutons Autoriser/Refuser, champ de réponse ; puis les « Étapes fixes de
  l'orchestrateur » (rendu, révision, échecs QA, validation). `ProductionPanel` distingue
  aussi « Décisions du modèle » et « Étape fixe ». Messages du fil : demande confiée,
  question ou autorisation demandée, vidéo prête.
- **Director simulé** : une demande « plus dynamique / rythme » sur la « scène N »
  enchaîne `media.inspect` puis `revision.apply` (`scene.animation` ×0,6 et
  `scene.transition`) ; scène introuvable → `ask_user`. Le résumé du projet transmis au
  Director inclut texte, animation, composant et présence de narration de chaque scène.
- **Suites de la démo réelle (2026-11-11)** : `composition.check` sur une révision sans
  composition sur disque (enfant `draft` de `revision.apply`) compose la révision depuis son
  storyboard (même compositeur que le rendu, sous-titres incrustés si le mode n'est pas
  `clean`) dans le dossier propre de l'appel `<prj>/tool-calls/<tcl_…>/` (sous la racine de
  stockage : bwrap masque `/tmp`), lance la vérification HyperFrames puis supprime ce dossier ;
  rien n'est écrit dans le dossier de la révision. Moteur autre que HyperFrames : « Composition
  absente », comme avant. Le prompt du Director indique qu'après `request_approval` le rendu, la
  QA et la validation humaine sont automatiques (étapes fixes), et recommande d'inspecter
  l'état avant de modifier quand c'est utile.
- **Démo réelle exécutée le 2026-11-11** (commit 6febdcd) avec `codex-chatgpt` et HyperFrames
  réel (`apps/studio/src/lib/server/director.real.test.ts`, RUNBOOK) : décisions du modèle
  `revision.apply` (scène 2 : `slide-up`, 450 ms), `composition.check` HyperFrames OK, puis
  `request_approval` ; rendu, QA (23 contrôles, 2 échecs mineurs) et attente de validation.
  Limites : le modèle n'a rien inspecté avant de modifier, voix off simulée, un seul essai
  (n=1). Détail et journal : [TASKS](../TASKS.md) (T129b-2) ; revue :
  [2026-11-11-t129b](../reviews/2026-11-11-t129b.md).
- **Pas encore** : pas de choix de la révision à modifier (la plus récente en attente) ;
  T129c (historique filtrable, coûts affichés, artefacts téléchargeables). `maxRenders`
  avant `audio.track.update` : traité par T129b-3 (§ 12).

Preuves : `apps/studio/src/lib/server/director-studio.test.ts`,
`packages/ai/src/director.test.ts`, `packages/ai/src/agents.test.ts`,
`apps/studio/tests/mvp.e2e.ts` ; détail dans [TASKS](../TASKS.md) (T129b-2).

## 12. Suites des revues T129b (T129b-3, 2026-11-11)

Corrections des défauts confirmés par la [revue indépendante](../reviews/2026-11-11-t129b.md)
et par la revue de sécurité du même jour. Aucune migration ; aucune transition de révision
ajoutée (`awaiting_approval → approved | changes_requested` suffit).

- **Parent validable jusqu'à la validation de l'enfant** (I2) : le rendu de l'enfant du
  Director ne remplace plus le parent (`supersede` supprimé). `Studio.approve` ferme les autres
  versions en attente de la même **vidéo** (D027, T149 : identité dérivée de l'origine ; une
  vidéo indépendante n'est jamais fermée, même reliée par un parent technique ; un enfant dont
  la source est validée pendant son rendu est fermé à la fin de sa QA, sans correction
  automatique) : valider l'enfant fait
  passer le parent `changes_requested` et termine sa phase de validation ; valider l'original
  (donc refuser l'enfant) ferme l'enfant. Un enfant annulé ou rejeté laisse le parent
  validable. Le fil l'annonce (« La révision vN reste validable… ») ; le champ de la page
  l'annonce avant envoi, explique la case « nouvelle vidéo indépendante », et n'annonce un
  montage que si le fournisseur effectif a la capacité `director` (`Studio.directorEdits`,
  M1) ; sinon il dit qu'une nouvelle vidéo sera produite.
- **`audio.track.update` dans une boucle** : `reviseAudio(…, { maxRenders })` ne touche ni au
  statut de la source ni à l'activité du projet ; la source reste validable après annulation
  ou rejet de l'enfant. Hors boucle (interface), comportement inchangé.
- **`maxRenders`** : `Studio.directorInLoop(projectId)` donne le run Director dont la boucle
  tourne ; avant l'appel, `audio.track.update` est refusé si ses rendus (révisions de la
  boucle et re-rendus automatiques, `rendersUsed`) ont épuisé `plan.budget.maxRenders`, et le
  run enfant reçoit le reste comme plafond.
- **`composition.check`** : chemins de l'hôte retirés de la sortie (modèle, base, page) :
  dossier vérifié → `composition`, racine de stockage → `<stockage>`, autre chemin personnel
  ou temporaire → `<chemin hôte>`, révision rendue comprise.
- **Réponse à `ask_user`** : bloc distinct `<reponse_utilisateur pas="N">` (2 000 octets au
  plus, `<`/`>` échappés), hors des blocs `<donnees_non_fiables>` ; la règle 3 du prompt dit
  qu'elle sert la tâche et n'accorde aucune permission.
- **Troncature UTF-8** : `untrusted()` coupe à la frontière d'un caractère.
- **Fournisseur figé par run** : `brief.provider` (`kind`, `model`) enregistré au démarrage ;
  `decideDirector`, `answerDirector`, `resumeProduction` et la phase `plan` refusent la reprise
  si le fournisseur effectif a changé (message : revenir au fournisseur d'origine ou arrêter
  puis faire une nouvelle demande). Le panneau affiche le fournisseur du run et celui de
  chaque pas (« boucle » pour un arrêt imposé) ; un ancien run sans `brief.provider` affiche
  le fournisseur enregistré par la phase, sinon « inconnu », jamais le fournisseur courant.
- **Appartenance du run** : `decideDirector(projectId, …)` et `answerDirector(projectId, …)`
  vérifient eux-mêmes que le run appartient au projet (en plus de la route).
- **Provenance** (M3) : l'enfant de `revision.apply` décidé dans une boucle enregistre le
  fournisseur du run dans `resolvedConfig.aiProvider` (`none` hors boucle).
- **Limites** : le run enfant d'`audio.track.update` garde sa propre phase de validation
  (en plus de celle du run Director ; non vérifié de bout en bout en réel) ; `captionDelivery`
  absent vaut toujours `burned`.

Preuves : `apps/studio/src/lib/server/director-studio.test.ts`, `director-loop.test.ts`,
`tools/tools.test.ts`, `packages/ai/src/director.test.ts` ; détail dans
[TASKS](../TASKS.md) (T129b-3).
