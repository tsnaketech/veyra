# Architecture des agents — studio de montage piloté par l'IA

Statut : **proposition du 2026-11-03** (mission Agent Architect), fondée sur quatre
audits en lecture seule (capacités exécutables, sécurité, tests, format des
sous-agents Claude Code) et sur la [note AI-native](../plans/ai-native-editing-studio-note.md).
Aucun runtime multi-agents n'est implémenté par ce document. Les contrats existants
restent la référence : [MULTI-AGENT-ARCHITECTURE](MULTI-AGENT-ARCHITECTURE.md)
(v0.3), [AGENT-WORKFLOWS](AGENT-WORKFLOWS.md) (fournisseurs, modes), registre
d'outils : [TOOL-REGISTRY](TOOL-REGISTRY.md).

Principe directeur (vision utilisateur du 2026-11-03) : **le choix créatif est
flexible et piloté par l'IA ; l'exécution technique est reproductible** (composition
validée, synchronisation, fichiers, sécurité, intégrité des révisions). Les cinq
composants Motion sont des outils, pas des limites.

## 1. Deux catégories d'agents, jamais confondues

| | Agents de développement Claude Code | Agents métier Veyra |
|---|---|---|
| Rôle | Développer et maintenir le dépôt | Produire des vidéos pour l'utilisateur du Studio |
| Où | `.agents/agents/*.md` (lien `.claude/agents`) | Code : `packages/ai`, `apps/studio/src/lib/server` (orchestrateur D019) |
| Exécution | Sessions Claude Code (outils Read, Edit, Bash…) | Phases d'un run, outils Veyra contrôlés (TOOL-REGISTRY) |
| Skills | `.agents/skills` (Veyra + externes, à la demande) | **Aucun** skill Claude Code n'est un outil runtime |
| Fournisseur | Session de l'utilisateur | `fake`, `anthropic-api`, `claude-subscribe` (assisté, D010) |

Un skill installé dans Claude Code (`ffmpeg-skill`, GSAP, Three.js…) n'est pas
accessible au Studio ; une capacité runtime n'existe que si un exécuteur Veyra
l'implémente (audit : aucun import de `.agents/skills` dans `packages/` ou `apps/`).

## 2. Inventaire (état réel au commit `f5b38db` + T116 en cours)

### 2.1 Agents métier existants

| Agent | Réalité dans le code | Fournisseur IA |
|---|---|---|
| Director | Règles déterministes `planProduction`, `planRevisionPhases` (`packages/ai/src/agents.ts`) ; phases exécutées par `Orchestrator` (`apps/studio/src/lib/server/production.ts`) | Aucun (règles) ; storyboard par `generateStoryboard` |
| Motion | Sélection de composants dans le storyboard du modèle (`storyboardDraftSchema`), compositeur fixe `compose()` | `generateStoryboard` (fake : mots-clés) |
| Audio | `proposeAudio`, `simulateAudioChange` (règles) ; moteur `@veyra/audio` | Aucun |
| Review | `planRevision` (commentaires → patches), `planRevisionPhases` (phases touchées) | `planRevision` |
| QA Expert | `QualityEvaluator` (`packages/ai/src/evaluation.ts`) + contrôles mesurés (`runner.ts`) | `evaluate` (fake : règles sans image) |
| Voice / Captions | v0.4 : `VoiceProvider` (`packages/audio/src/voice.ts`), `buildFallbackCaptions`, `refreshCaptions` (`studio.ts`) — **fonctions de service, sans agent** | Aucun |

Les « agents » de `agentIdSchema` (`packages/schemas/src/production.ts`) sont des
étiquettes de phase ; la logique est répartie entre `ai/agents.ts` et `studio.ts`
(~2 300 lignes). Aucun modèle n'appelle d'outil : `AnthropicProvider` fait un appel
en sortie structurée, sans `tools` (cohérent avec D007).

### 2.2 Sous-agents Claude Code

Avant cette mission : **aucun** fichier `.claude/agents/` (ni projet ni utilisateur) ;
seul l'agent de plugin `codex:codex-rescue` existe. Les rôles utilisés jusqu'ici
(Motion Engineer, QA Engineer, Testing Agent, Independent Reviewer…) étaient des
agents génériques recevant un rôle dans leur consigne. Créés par cette mission :
§ 7.

### 2.3 Outils réellement exécutables

Détail et statut par outil : [TOOL-REGISTRY § 3](TOOL-REGISTRY.md#3-catalogue-initial).
Résumé : **réels** — HyperFrames compose/check/lint/render sous bwrap, FFmpeg
(probe, frames, PSNR, photosensibilité, contraste, mixage, mux, analyses audio),
sous-titres (quantification, SRT/VTT), patches de storyboard/audio, QA mesuré ;
**simulés** — `FakeAiProvider`, `FakeQualityEvaluator`, voix `fake`, `FakeEngine`,
`colorEngine` (vrai MP4 ffmpeg, mais **pas** HyperFrames) ; **bouchons** — `local-tts`,
transcription, alignement ; **absents** — Three.js, outils de montage FFmpeg (coupe,
recadrage, vitesse), FLORA, Google Flow, `snapshot` au runtime.

### 2.4 Doublons et chevauchements

| Doublon | Où | Arbitrage |
|---|---|---|
| Trois lanceurs de processus (`runProcess` env hérité sans prlimit ; `runAudioProcess` prlimit + env minimal ; `streamFrames` spawn direct) + `Sandbox`/`runEngine` + `execFile` | `packages/video`, `packages/audio`, adaptateur, `assisted.ts` | Un seul exécuteur d'outil (env minimal obligatoire, binaires en liste blanche, prlimit) : T132 |
| Quatre sondes (`probe` sans whitelist, `probeVideoStream`, `readMediaProbe`, `probeAudio`), trois schémas | `video`, `audio` | Garder `probe` (vidéo) et `probeAudio` (validation import) ; whitelist partout (T132) |
| Trois extractions de frames | `packages/video/src/index.ts` | Outil unique `inspect.frames` par index ; `extractFrames` (seek approximatif) réservé à la revue rapide |
| Logique d'agents en deux couches | `ai/agents.ts` + `studio.ts` runners | Pas de refonte : les exécuteurs d'outils naissent à côté des runners (T127, T129) |
| Deux évaluations qualitatives facturables (`reviewFrames` à chaque rendu, `QualityEvaluator`) | `studio.ts` | Budget unique (T133) ; à terme une seule évaluation indépendante |
| Deux verdicts de contraste (DOM HyperFrames, pixels T104) | runner | Voulu (le second remesure le premier) |
| Rôles demandés en double : Creative Director / Director ; Captions / Audio & Voice | mission | Fusionnés (§ 3) |

### 2.5 Contraintes de sécurité et d'exécution (audit)

Conservées : bwrap sans réseau, prlimit, Zod partout, `safePath`, révisions
immuables, enveloppes de phase (D019), QA indépendant, validation humaine,
`claude-subscribe` assisté. **Écarts à corriger avant toute délégation d'outils** :

1. Studio exposé sur le LAN sans authentification (choix utilisateur du 2026-11-03,
   contraire à SECURITY) : un client du réseau peut basculer vers l'API facturable
   ou injecter des consignes dans les tâches assistées.
2. `runProcess` transmet tout `process.env` (dont les jetons) aux ffmpeg/ffprobe du
   paquet vidéo ; `probe()` sans `-protocol_whitelist file`.
3. Appels facturables hors budget : `reviewFrames` après chaque rendu,
   `requestEvaluation` automatique.
4. La sandbox monte la racine hôte en lecture : interdit d'exécuter du code écrit
   par l'IA tant qu'elle n'est pas durcie (TOOL-REGISTRY § 5).

## 3. Architecture cible légère

Rationalisation des neuf rôles proposés :

| Rôle | Forme retenue | Justification |
|---|---|---|
| **Director** | **Agent IA** (un appel structuré qui produit un `ProductionPlan` + `ToolPlan`) | Seul décideur ; choisit techniques et outils ; n'exécute rien |
| Creative Director / Storytelling | **Compétence du Director** (rubrique créative dans ses consignes, références de style en données) | Un second agent ajouterait un appel sans responsabilité exécutable propre ; leçons OpenMontage reprises comme critères, pas comme code |
| Motion | **Ensemble d'outils** (`motion.component.*`, `composition.compose`, plus tard DSL `composition.dsl`) + règles du Director | Exécution déterministe ; la créativité est dans le plan |
| Video Editing | **Ensemble d'outils** FFmpeg (à créer : coupe, recadrage, vitesse, transitions) | Pas de jugement propre au-delà du plan |
| Audio & Voice **+ Captions** | **Ensemble d'outils** (`voice.*`, `audio.*`, `transcription.*`, `alignment.*`, `captions.*`) | Fusion : mêmes artefacts temporels, même moteur |
| Generative Media | **Outils d'import** (manuel) puis outils `network-external` + `billable` (v0.5) | Pas d'API Flow ; FLORA sous autorisation |
| **Review** | **Agent IA** (existant `planRevision`) | Interprète des commentaires humains en opérations ciblées |
| **QA Expert** | **Agent IA isolé** (appel séparé, sans contexte du planificateur) + contrôles mesurés | L'indépendance exige un contexte distinct ; aujourd'hui il reçoit `plannedChanges` (écart à corriger, T134) |
| QA mesuré | **Outils** déterministes | Mesures, pas jugements |

Donc **trois agents IA** (Director, Review, QA Expert), tous existants, et des
**exécuteurs d'outils** déterministes appelés par le plan. Pas de nouveau
processus, pas de boucle d'outils multi-tours tant que D007 n'est pas révisée
(question ouverte § 9).

```text
Brief / commentaires
   │
   ▼
Director (IA, 1 appel structuré) ──► ProductionPlan + ToolPlan (données)
   │                                     │ validé Zod, budget, permissions
   ▼                                     ▼
Orchestrateur D019 (phases persistées) ──► exécuteurs d'outils (TOOL-REGISTRY)
   │                                          motion · composition · render · ffmpeg
   │                                          voice · captions · inspect · import
   ▼
Nouvelle révision (artefacts + manifeste, parent intact)
   │
   ▼
QA mesuré (outils) ─► QA Expert (IA isolée, consultatif) ─► Validation humaine
   │ défauts mesurés                           ▲
   └──► boucle de correction bornée (Director → ToolPlan ciblé) ┘
```

## 4. Matrice responsabilités → agents → outils → skills

| Responsabilité | Agent métier | Outils runtime (statut) | Skills de dev (sous-agent) |
|---|---|---|---|
| Interpréter le brief, narration, style | Director | — (appel IA) | `prompt-to-video` (motion-engineer) |
| Storyboard, choix des techniques | Director | `motion.component.list` (réel) | `prompt-to-video` |
| Composants animés | Director → outils | `motion.component.build`, `composition.compose` (réels) | `gsap-core`, `gsap-timeline` à la demande (motion-engineer) |
| Composition originale | Director → outils | `composition.dsl` (**à créer**, T131) ; code généré **interdit** | `hyperframes`, `gsap-*` |
| 3D | Director → outils | **absent** (T103 POC sur besoin) | `threejs-*` à la demande |
| Rendu | moteur | `render.hyperframes` (réel, bwrap) | `video-rendering` (video-pipeline-engineer) |
| Montage de rushs | Director → outils | `ffmpeg.*` (**à créer**) | `ffmpeg-skill` (dev seulement) |
| Voix off | Director → outils | `voice.import` (réel), `voice.fake` (simulé), `voice.local-tts` (bouchon, T117) | `audio-production` (audio-voice-engineer) |
| Mixage, atténuation | Director → outils | `audio.place`, `audio.mix` (réels) | `audio-mixing` |
| Sous-titres | Director → outils | `captions.build`, `captions.quantize`, `captions.export` (réels) ; `transcription.*`, `alignment.*` (bouchons, T118–T119) | `audio-mixing`, `video-rendering` |
| Médias génératifs | Director → outils | import manuel (v0.5) ; FLORA (autorisation) | — |
| Commentaires → corrections | Review | `revision.patch` (réel : `applyProposal`, audio, voix, sous-titres) | `video-review` (contracts-data-engineer) |
| Inspection | QA / Director | `inspect.frames`, `inspect.probe`, `qa.measure.*` (réels) | `video-quality-assurance` (testing-engineer) |
| Jugement qualitatif | QA Expert | `qa.evaluate` (fake simulé ; API réelle non testée) | `video-quality-assurance` |
| Validation | humain | Studio | — |

## 5. Contrats entre agents (réutiliser d'abord)

| Contrat demandé | Existant | Décision |
|---|---|---|
| ProductionBrief | `productionBriefSchema` (`production.ts`) | Réutiliser |
| CreativePlan | `ProductionPlan` (phases, budget) | Étendre par un champ `creative` (intention, style, références) — T129 |
| ScenePlan | `sceneSchema` (+ `component`, `narration`) | Réutiliser ; ajouter `technique` (`component`, `dsl`, `media`, `text`) à terme |
| ToolInvocation / ToolResult | `agentResultSchema` (enveloppe de phase) | **Nouveau** contrat d'appel d'outil réutilisant l'enveloppe (TOOL-REGISTRY § 2) — T127 |
| MediaArtifact | `assetSchema` (+ `audio`), chemins de rendu, `captions` | Ajouter un manifeste d'artefact (sha256, outil, run) — T127 |
| EditOperation | `scenePatchSchema`, `audioMixPatchSchema`, `revisionEditSchema` (v0.4) | **Union typée** couvrant scène, média, animation, audio, sous-titres — T128 |
| ReviewRequest | `feedbackSchema` (frame, plage, piste, cue), lots | Réutiliser |
| QAReport | `qualityReportSchema`, `qualityEvaluationSchema` | Réutiliser |
| RevisionProposal | `revisionProposalSchema`, `reviewPlanSchema` | Réutiliser ; les `changes` deviennent des `EditOperation` |

Traçabilité exigée de chaque opération : demande (prompt, commentaire ou lot) →
agent → outil → scène/média → révision → artefacts (sha256) → résultat validé ou
erreur explicite. L'orchestrateur D019 porte déjà run, phase, révision et
provenance ; il manque l'enregistrement par appel d'outil (T127).

## 6. Exemples

Plan de production dynamique et correction localisée :
[AGENT-WORKFLOWS § Plans dynamiques](AGENT-WORKFLOWS.md#plans-dynamiques-proposition).

## 7. Sous-agents de développement Claude Code

Définitions dans `.agents/agents/` (lien `.claude/agents`), format vérifié pour
Claude Code 2.1.317 (champs `name`, `description` obligatoires ; `tools`,
`disallowedTools`, `model`, `skills`, `maxTurns`). Tous chargent CLAUDE.md et donc
AGENTS.md (règles communes non recopiées). Aucun n'utilise de mode de permission
élargi.

| Sous-agent | Périmètre | Écrit | Skills préchargés |
|---|---|---|---|
| `motion-engineer` | `packages/motion`, `compose.ts`, calque de sous-titres | Code + tests de son périmètre | `prompt-to-video`, `video-rendering` |
| `video-pipeline-engineer` | runner, sandbox, adaptateur HyperFrames, `packages/video`, routes média | Code + tests | `video-rendering`, `video-quality-assurance` |
| `audio-voice-engineer` | `packages/audio`, voix, sous-titres côté service, moteurs locaux | Code + tests | `audio-production`, `audio-mixing` |
| `contracts-data-engineer` | `packages/schemas`, migrations **nouvelles**, dépôt | Code + tests | `video-review` |
| `testing-engineer` | Tests seulement (pas de code de production) | Tests, TESTING.md | `video-quality-assurance` |
| `security-reviewer` | Audit, lecture seule | Rien | — |
| `independent-reviewer` | Revue des commits et des preuves | Sondes temporaires `zz-review-*` supprimées | — |
| `research-analyst` | Recherche documentaire, licences, comparatifs | Un document de recherche demandé | — |

Rôles non créés et pourquoi : « Agent Architect » = session principale (et agent
intégré `Plan`) ; « QA Engineer » = `video-pipeline-engineer` pour le code QA et
`testing-engineer` pour les preuves ; exploration = agent intégré `Explore`.
Contrôle des définitions : `packages/config/src/agents.test.ts`.

## 8. Tâches incrémentales proposées

| ID | Travail | Réutilise | Critère |
|---|---|---|---|
| T132 (P0) | Exécuteur de processus unique : env minimal obligatoire, `-protocol_whitelist file` dans `probe`, prlimit pour `packages/video` ; corriger SECURITY | `runAudioProcess` | Test : aucune variable secrète dans l'env d'un ffprobe |
| T133 (P1) | Budget unique des appels facturables (`reviewFrames`, `requestEvaluation`, hors run) décrémenté avant l'appel | `maxAiCalls` (D019) | Test : appel refusé au-delà du budget |
| T134 (P1) | QA Expert isolé : entrée sans `plannedChanges` ni contexte du planificateur (ou séparé et marqué) | `EvaluationInput` | Test espion de l'entrée de l'évaluateur |
| T135 | `colorEngine` déclaré `kind: 'test-color'` (ne plus se dire HyperFrames) | — | Rapports de test honnêtes |
| T127 | Registre d'outils : descripteurs Zod → JSON Schema, classes de permission, disponibilité ; interfaces `TranscriptionProvider`, `AlignmentProvider` ; outils Voice/Transcription/Alignment/Captions/Inspect | `VoiceProvider.available()`, `z.toJSONSchema` | Via descripteur = appel direct ; sans moteur : « indisponible » sans erreur |
| T128 | `EditOperation` (union typée) et graphe d'invalidation des artefacts | `scenePatchSchema`, `revisionEditSchema`, `reusablePicture` | Une opération ne touche que ses artefacts |
| T129 | Director : `ToolPlan` en données (1 appel), validé, budgété, exécuté par l'orchestrateur | D019, `planProduction` | Brief contrasté → plan différent ; outil indisponible → refus explicite |
| T130 | Cache de rendu par scène (décision complétant D019) | `reusablePicture` | Scène modifiée seule rendue |
| T131 | POC DSL de composition originale (primitives + tweens en données) | `compose()`, `scriptJson` | Composition hors des 5 composants, frame exact, check sans erreur |
| T136 | Décision LAN : `127.0.0.1` ou authentification + CSRF | SECURITY | Choix utilisateur |

Ordre recommandé : T132 → T127 (prochain incrément, voir § 10) → T134/T133 → T128 →
T129 → T130/T131 ; v0.4 continue en parallèle (T116–T124).

## 9. Risques et questions ouvertes

- D007 (plan en données, pas de boucle d'outils) : à garder pour les outils qui
  écrivent ; une boucle limitée aux outils en lecture seule exige une nouvelle décision.
- Code écrit par l'IA : refusé tant que la sandbox lit la racine hôte ; DSL d'abord.
- Preuves IA réelles : aucun test automatique n'exerce `anthropic-api` ; choix de
  composants, ciblage des commentaires et expertise QA ne sont prouvés que par le
  test manuel `claude-subscribe` (à rejouer et consigner).
- Exposition LAN, fuite d'env, budgets : § 2.5.
- PRD (voix off et génération externe hors MVP) et ROADMAP (gabarit) à actualiser.

## 10. Prochain incrément recommandé

**T132 puis T127** : sécuriser l'exécution (env minimal, whitelist, prlimit) avant
d'exposer quoi que ce soit, puis le registre d'outils avec les descripteurs Voice,
Transcription, Alignment, Captions, Inspect et Motion, sans changer les moteurs ni
les migrations.
