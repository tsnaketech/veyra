# Boucle d'outils bornée du Director (architecture, T129)

Statut : **architecture proposée le 2026-11-04** ; moteur de pas **sans IA implémenté le
2026-11-11** (T129a, § 9) ; Director IA (T129b) et affichage (T129c) à faire. Décisions :
D021 (proposée) et [D026](../DECISIONS.md#d026--boucle-doutils-t129a--pas-persistés-et-pause-par-action)
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
