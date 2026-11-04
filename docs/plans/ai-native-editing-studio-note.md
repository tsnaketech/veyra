# Note d'architecture — Veyra, « AI-Native Editing Studio »

Statut : **note d'architecture, non validée**. Rédigée le 2026-11-03 sur la branche
`feat/qa-expert-v0.1` (commit `f5b38db`), à partir de la lecture du dépôt
uniquement. Aucune implémentation, aucune tâche créée dans [TASKS](../TASKS.md),
aucun appel externe. Elle ne remet pas en cause T111–T115 (v0.4, faites) et
s'articule avec le [brief v0.4](v0.4-voice-captions.md) (T116–T126) et la
[note v0.5](v0.5-generative-media-note.md). Les numéros T127+ sont des
**propositions**. « Hypothèse » = non vérifié dans le code.
Les références `chemin:ligne` visent le commit `f5b38db` ; pendant la rédaction,
des modifications non commitées liées à T116 sont apparues (`packages/audio/src/voice.ts`,
`engines.ts`, `config/voice.yaml`, sandbox) : les lignes de `voice.ts` ont pu bouger.

## 0. Résumé

- **La vision ne demande pas une nouvelle architecture multi-agents.** Les
  briques nécessaires existent en grande partie : orchestrateur persisté (D019),
  enveloppes validées par phase, fournisseurs `fake` / `anthropic-api` /
  `claude-subscribe` sans basculement (D010, D011), moteurs déterministes
  (composition, rendu sandboxé, mixage, sous-titres, mesures QA), expertise QA
  séparée (D015), révisions immuables et réutilisation de l'image (`reusablePicture`).
- **Ce qui manque est surtout un contrat** : (1) un *catalogue d'outils* qui
  décrit en données les fonctions existantes (entrées/sorties Zod → JSON Schema,
  effets, coût, permission, disponibilité, déterminisme) ; (2) des *opérations
  d'édition* typées plus larges que `scenePatchSchema` ; (3) un *plan d'outils*
  produit par le Director, validé et exécuté par des exécuteurs déterministes.
- **Principe directeur** : le choix créatif (quel outil, quels paramètres,
  pourquoi) est une **donnée produite par l'IA** ; l'exécution (composition,
  rendu, mixage, synchronisation, exports, révisions) reste **reproductible et
  hors de l'IA**. C'est déjà la règle de D007/D017 ; on l'étend aux outils.
- **Recommandation sur la composition originale** : d'abord un **DSL de
  composition contraint** (primitives et tweens en données, compilées par le
  compositeur fixe) ; le code généré sous sandbox reste une option ultérieure,
  sous nouvelle décision, parce que la sandbox actuelle protège le réseau et les
  écritures mais **pas la confidentialité des fichiers locaux** (SECURITY).
- **Recommandation sur l'usage des outils par le modèle** : *plan comme données*
  (un appel structuré produit un plan d'appels d'outils), pas de boucle agentique
  serveur pour l'instant. Compatible D007 et le mode assisté D010 ; la boucle
  outillée (tool use multi-tours) ne serait ouverte qu'aux outils en lecture seule,
  par décision explicite.
- **Premier pas proposé (T127)** : descripteurs d'outils pour Voice /
  Transcription / Alignment et pour les fonctions déterministes existantes, sans
  changer aucun moteur ni aucun prompt.

## 1. Inventaire

### 1.1 Réutilisable tel quel

| Brique | Où | Rôle dans la vision |
|---|---|---|
| Orchestrateur persisté, reprise, budget d'appels IA | `apps/studio/src/lib/server/production.ts:81`, `:214` | Exécuteur des plans ; `PhaseRunner.usesAi` (`:35`) compte déjà les appels |
| Enveloppe de résultat (agent, fournisseur, `inputHash`, validation) | `packages/schemas/src/production.ts:70` | Trace d'un appel d'outil, sans nouveau format |
| Plan du Director en données | `productionPlanSchema` `production.ts:36`, `planProduction` / `planRevisionPhases` `packages/ai/src/agents.ts:28`, `:54` | Base du « plan d'outils » |
| Fournisseurs explicites, aucun basculement | `packages/ai/src/index.ts:121`, `:572` ; `assisted.ts:33` | Inchangés : le plan d'outils est une sortie de plus |
| Catalogue → JSON Schema | `componentCatalog` `packages/motion/src/index.ts:207`, `outputSchema` `assisted.ts:89` (`z.toJSONSchema`, Zod 4) | Mécanisme déjà utilisé pour décrire des données au modèle |
| Registre Motion (5 composants, données seulement) | `packages/motion/src/registry.ts:100`, `index.ts:29` | Outils « composant » ; D017 inchangée |
| Composition fixe + calque de sous-titres | `packages/hyperframes-adapter/src/compose.ts:48`, `:182` | Exécuteur de composition |
| Moteur vidéo (`validate`, `check`, `render`, `inspect`) | `hyperframes-adapter/src/index.ts:122` ; `Sandbox` `sandbox.ts:40` | Exécuteur de rendu, `check` = lint avant rendu |
| Audio Engine (probe, résolution d'ancrages, mixage, mux, mesures) | `packages/audio/src/validation.ts:116`, `timeline.ts:16`, `mixing.ts:19`, `:131`, `:155`, `analysis.ts:161`, `:182` | Outils audio déterministes |
| `VoiceProvider` (`import`, `fake`, `local-tts` stub) avec `available()` | `packages/audio/src/voice.ts:23`, `:108` ; `placeSceneVoice` `:139` | Modèle exact du descripteur avec sonde de disponibilité |
| Sous-titres purs : mots de repli, regroupement, quantification, SRT/VTT | `packages/schemas/src/captions-format.ts:51`, `:103`, `:173`, `:224` | Outils déterministes, une seule source de temps |
| Résultats Voice / Transcription / Alignment validés | `packages/schemas/src/captions.ts:193`, `:213`, `:221` | Sorties d'outils déjà contractualisées (simulé ⇔ `fake`) |
| Mesures QA | `packages/video/src/index.ts:150` (`deterministicChecks`), `:265`, `:320` (frames par index), `:298` (PSNR), `text-contrast.ts:286`, `photosensitivity.ts:318` | Outils d'inspection |
| Expertise QA indépendante | `QualityEvaluator` `packages/ai/src/evaluation.ts:105` | Juge distinct du créateur |
| Réutilisation de l'image | `pictureKey` / `reusablePicture` `apps/studio/src/lib/server/jobs/runner.ts:102`, `:407` | Germe du cache par scène |
| Correction automatique bornée (défauts techniques seulement) | `apps/studio/src/lib/server/studio.ts:672` | Modèle de boucle bornée |

### 1.2 Réutilisable avec adaptation

- **`productionPlanSchema`** : une ligne de phase par nom (`phaseSchema`, enum
  fermée, `production.ts:13`) ; l'orchestrateur retrouve une phase par son nom
  (`production.ts`, méthode `phase`). Plusieurs appels d'outils dans un run
  exigent soit de les loger **dans** le payload d'une phase existante (option
  minimale), soit d'ajouter une phase générique `tool` identifiée par un `stepId`
  (migration et changement de D019).
- **`scenePatchSchema`** (`core.ts:431`) : texte, durée, entrée, rythme, params.
  Ne sait ni insérer, ni supprimer, ni réordonner une scène, ni changer de
  composant. `revisionEditSchema` (`apps/studio/src/lib/server/production.ts:43`) couvre voix,
  narration et livraison des sous-titres, hors IA.
- **`AiProvider`** : méthodes fixes (`generateStoryboard`, `planRevision`,
  `reviewFrames`). Un plan d'outils = une méthode de plus (ou un `kind` assisté de
  plus dans `outputs()`, `assisted.ts:20`), pas une refonte.
- **Budget** : `{ maxAiCalls, maxRenders }` (`studio.ts:360` : 3 appels). Pas de
  budget de temps CPU, ni monétaire, ni par classe de permission.
- **`pictureKey`** : compare tout le storyboard sauf `narration` ; c'est
  « tout ou rien » au niveau de la vidéo, pas par scène.
- **Transcription / Alignment** : seuls les **schémas de résultat** existent ;
  il n'y a **aucune interface TypeScript** `TranscriptionProvider` /
  `AlignmentProvider` dans le code (recherche sur le dépôt), contrairement au
  brief v0.4 § 4.1. Écart à combler par T127, pas un défaut de T111–T115.
- **Écart de contrat à trancher** : `alignmentResultSchema` n'admet que
  `aligned` et `tts` (et `scene` si simulé) ; or le brief liste `asr-approx` et
  `scene-fallback` parmi les modes d'alignement. Ils produisent des temps `asr`
  et `scene` : ce sont des *outils* qui rendent des `CaptionWord[]`, pas des
  `AlignmentResult`. À dire dans le descripteur plutôt qu'à forcer dans le schéma.

### 1.3 Ce qui bloque la vision

1. **Storyboard fermé** : une scène est texte ou composant du registre
   (`sceneSchema` `core.ts:161` ; `sceneDraftSchema` `ai/src/index.ts:32`). Pas
   de scène média (prévue v0.5 § 6), pas de calque, pas de composition libre.
2. **`compose()` fixe** : chaque scène est un clip unique, une piste par scène,
   fondu de sortie imposé, aucune superposition (`compose.ts:48` et suivantes).
3. **Interdiction faite au modèle d'écrire HTML/CSS/JS** (SECURITY, D007, D017,
   `instructions.storyboard` `ai/src/index.ts:533`). Raisons, qui restent
   valables :
   - le rendu exécute la composition dans Chrome ; un script non fiable peut lire
     tout ce que la sandbox monte en lecture (**racine hôte lisible**, SECURITY
     « Sandbox du rendu ») et l'incruster dans les images rendues, qui sortent
     ensuite du bac à sable ;
   - le déterminisme du rendu par seek (règle T095, `immediateRender`) n'est pas
     vérifiable sur du code arbitraire : `Math.random`, `Date`, état global ;
   - injection de consignes : un média ou un commentaire peut contenir des
     instructions qui deviendraient du code ;
   - la QA et le cache par clé supposent une entrée en données.
4. **Pas de boucle agentique** côté serveur (D007) et, en mode assisté, une
   étape manuelle par requête (D010) : une boucle « inspecte → corrige » coûte
   une intervention humaine par tour dans ce mode.
5. **PRD** : « Hors MVP : montage de rushes, voix off, génération d'images
   externe » (`docs/PRD.md`, Invariants). La vision dépasse le PRD actuel ;
   ROADMAP est un gabarit (« À définir »). À mettre à jour par l'utilisateur,
   non déduit ici.

### 1.4 Composition originale : options comparées

| Option | Principe | Sécurité | Déterminisme | Coût | Avis |
|---|---|---|---|---|---|
| A. Élargir le registre | Nouveaux composants maison (D017) | Inchangée | Inchangé | Développement par composant | Toujours utile, mais pas « original » |
| B. **DSL contraint** | Scène `freeform` : arbre de primitives bornées (`text`, `shape`, `image`/`media` par `assetId`, `group`), positions en % de la zone sûre, styles en listes fermées, animations = `tweenSchema` / `counterSchema` existants (`registry.ts:34`, `:49`), écrits par le compositeur fixe | Même modèle que D017 : HTML échappé, aucune CSS libre, Zod | Compatible T095 si la règle « une entrée par propriété » est validée statiquement par le schéma | Moyen : un compilateur de primitives dans `compose.ts` | **Recommandé** ; couvre une large part du besoin 2D/GSAP |
| C. Code généré sandboxé | Le modèle écrit HTML/GSAP (ou Three.js) ; contrôles statiques (AST : liste blanche d'API, ni `fetch`, `eval`, `import`, `Math.random`, `Date`), CSP, `hyperframes check`, bwrap sans réseau **avec montages lisibles réduits**, validation humaine | Nouveau risque (lecture locale, contournement des contrôles statiques) | Non garanti ; à mesurer par rendus répétés | Élevé : analyseur, nouvelle sandbox, revue | Plus tard, usage personnel, nouvelle décision remplaçant une partie de D007/D017 |

Three.js relève de C (code WebGL) sauf à le limiter à des scènes paramétrées
maison (option A) ; SKILLS-STRATEGY § 6.4 le réserve à un POC approuvé.

## 2. Capacités et outils exposés aux agents

### 2.1 Contrat de descripteur (données, aucun code exécutable)

```ts
// Proposition : packages/schemas/src/tools.ts (contrat), descripteurs à côté de chaque moteur.
toolDescriptor = {
  id: "voice.synthesize",            // stable, jamais réutilisé (comme les ids de composants)
  version: 1,                        // incompatible ⇒ version 2
  description: string,               // français, pour le modèle et l'UI
  input: ZodType, output: ZodType,   // exposés via z.toJSONSchema (Zod 4, déjà utilisé)
  effects: "none" | "workspace" | "asset" | "revision",  // ce que l'exécution écrit
  cost: "free" | "local-cpu" | "billable",
  permission: "read-only" | "local-compute" | "billable" | "external",
  availability: () => { ok, reason?, installHint? },     // = VoiceAvailability (voice.ts:16)
  determinism: "pure" | "engine-pinned" | "non-deterministic" | "simulated",
  provenance: { engine, version, model?, sha256? },       // = captionProvenanceSchema
}
toolCall   = { stepId, toolId, toolVersion, input, rationale, dependsOn: stepId[] }
toolResult = agentResultSchema(output)  // enveloppe existante, provider "engine"/"rules"/fournisseur IA
```

Règles : sortie revalidée par Zod avant persistance (comme D019) ; `simulated` ⇔
fournisseur `fake` (règle déjà portée par `captions.ts`) ; `billable` et
`external` jamais exécutables sans autorisation explicite par appel ; une sonde
`availability` ne télécharge rien et ne lance aucun réseau ; enregistrement
**statique** dans un tableau versionné (comme `motionComponents`), pas de
découverte par import ni de chargement d'`.env` (défauts relevés chez
OpenMontage, [évaluation](../research/OPENMONTAGE-EVALUATION.md) § 3).

### 2.2 Correspondance avec l'existant

| Outil proposé | Fonction existante | Permission / coût | Déterminisme |
|---|---|---|---|
| `motion.component.<id>` (×5) | `buildComponentScene`, schémas du registre | read-only (produit des données) | pure |
| `motion.catalog` | `componentCatalog` | read-only | pure |
| `composition.compose` | `compose(storyboard, format, style, captions?)` | local-compute, workspace | pure (empreinte testée) |
| `composition.check` | `VideoEngine.check` (`hyperframes check --json`) | local-compute | engine-pinned |
| `render.video` | `RenderJobRunner` / `VideoEngine.render` (bwrap) | local-compute, revision | engine-pinned |
| `ffmpeg.<opération>` | `buildMixArgs`, `muxAudio`, extraction de frames : argv construits par code, jamais par le modèle | local-compute | pure / engine-pinned |
| `audio.probe`, `audio.resolve`, `audio.mix` | `probeAudio`, `resolveAudioComposition`, `mixToWav` | local-compute | pure |
| `audio.propose` | `proposeAudio` (règles) | read-only | pure |
| `voice.import` | `importedVoiceResult` + `Studio.importVoice` | local-compute, asset | pure |
| `voice.synthesize` (`fake`, `local-tts`) | `voiceProvider(kind).synthesize` | local-compute, asset ; `local-tts` indisponible (stub `voice.ts:86`) | simulated / engine-pinned |
| `voice.place` | `placeSceneVoice` | read-only (produit une composition) | pure |
| `transcription.transcribe` (`fake`, `local-asr`) | **à créer** (interface), résultat `transcriptionResultSchema` | local-compute ; `local-asr` après T118 | simulated / engine-pinned |
| `alignment.align` (`fake`, `tts-durations`, `ctc`) | **à créer** (interface), résultat `alignmentResultSchema` | local-compute ; `ctc` après T119 | simulated / engine-pinned |
| `captions.fallback-words` | `sceneFallbackWords` (temps `scene`, approximatif) | read-only | pure |
| `captions.group`, `captions.quantize`, `captions.export` | `groupCaptions`, `quantizeCues`, `toSrt` / `toWebVtt` | read-only | pure |
| `inspect.frame`, `inspect.frames` | `extractFrameByIndex`, `extractFramesByIndex` | read-only (fichiers temporaires) | pure |
| `inspect.compare` | `compareFrames` (PSNR) | read-only | pure |
| `inspect.video-checks` | `deterministicChecks`, `measureTextContrast`, `analyzeFlashes` | read-only | pure |
| `inspect.audio` | `analyzeAudio`, `detectOnsets`, `audioQualityChecks` | read-only | pure |
| `inspect.contact-sheet` | **à créer** (ffmpeg `tile`, argv fixe) | read-only | pure |
| `media.import` (v0.5) | `probeMedia` / `normalizeMedia` proposés (note v0.5 § 3) | local-compute, asset | engine-pinned |
| `media.flora.*`, `media.flow.import` | export manuel puis import (v0.5) ; API FLORA plus tard | `external` / `billable`, autorisation par appel | non-deterministic |

### 2.3 Voice / Transcription / Alignment comme outils (T111–T119)

Les moteurs ne changent pas : le descripteur **enveloppe** l'interface du
fournisseur. `voiceProvider(kind)` devient trois descripteurs de la même
famille (`voice.synthesize` avec `input.provider ∈ {fake, local-tts}`, `voice.import`)
dont `availability` délègue à `available()`. Transcription et Alignment
reçoivent une interface calquée sur `VoiceProvider` (`available()` + méthode
unique), avec `fake` et des stubs « Moteur non installé » ; T116–T119 n'auront
qu'à remplacer le stub, comme pour `local-tts`. Le Director peut alors *choisir*
(« voix importée existante → alignement `ctc` si disponible, sinon
`captions.fallback-words` ») au lieu d'une chaîne figée, et chaque choix laisse
une trace (`rationale`, précision affichée). Les règles v0.4 restent
contraignantes : jamais de temps « précis » sans moteur réel, jamais de
remplacement silencieux d'un moteur indisponible (`voice.ts:108`).

## 3. Planification et choix dynamique des outils

### 3.1 Plan comme données

```text
Brief / commentaires ─▶ Director (fournisseur actif) ─▶ EditPlan (données)
                         catalogue JSON Schema            │ validation Zod, outils connus,
                         + état de la révision            │ disponibilité, permissions, budget
                                                           ▼
                                        dry-run (coût estimé, effets, invalidations)
                                                           │ approbation humaine si requise
                                                           ▼
                        exécuteurs déterministes (phases de l'orchestrateur D019)
                                                           ▼
                            révision enfant → QA mesurée → expertise → humain
```

`EditPlan = { summary, steps: toolCall[], edits: editOperation[] (§ 4),
estimate: { aiCalls, renders, cpuSeconds?, usd: 0 } }`. Le plan est une sortie
structurée unique : `messages.parse` pour `anthropic-api` (D007 inchangée),
`request.json` d'un nouveau `kind` (`edit-plan`) pour `claude-subscribe`, règles
déterministes pour `fake` (étiquetées « [Simulé] »). Le catalogue est passé comme
`componentCatalog` aujourd'hui (texte + JSON Schema), pas comme `tools` d'une
boucle d'appels.

### 3.2 Validation et garde-fous (avant toute exécution)

1. Schéma Zod du plan, puis de chaque `input` par le schéma de son outil.
2. Outil connu, version connue, `availability().ok` ; sinon refus explicite
   (pas de substitution, règle D011 appliquée aux outils).
3. Permission : la politique du run autorise par défaut `read-only` et
   `local-compute` ; `billable`/`external` exigent une autorisation humaine
   **par appel** (montant, destinataire, données transmises), jamais héritée.
4. Budget : `maxAiCalls`, `maxRenders` existants ; proposition d'ajouter
   `maxToolSteps` et `maxCorrectionRounds`. Dépassement estimé ⇒ refus avant
   exécution, pas en cours de route.
5. Identifiants filtrés sur la révision (comme les ids proposés aujourd'hui).
6. **Dry-run** : effets, artefacts invalidés (§ 4.2), rendus nécessaires,
   affichés dans le Studio sans rien écrire.

### 3.3 Intégration à l'orchestrateur (D019)

Option minimale recommandée : garder les phases (`plan`, `script`, `motion`,
`audio`, `composition`, `render`, `qa`, `human-approval`) ; le payload de la
phase `plan` porte l'`EditPlan` ; chaque phase exécute la sous-liste d'étapes qui
la concerne (Motion : outils `motion.*`/composition ; Audio : `audio.*`,
`voice.*`, `alignment.*`, `captions.*`) et persiste ses résultats d'outils dans
son enveloppe. Pas de migration. Limite : la reprise se fait par phase, pas par
étape ; une phase relance toutes ses étapes en cas d'échec (acceptable tant que
les étapes sont déterministes et locales). Une phase générique `tool` par étape
n'est justifiée que si des étapes coûteuses ou externes doivent reprendre
individuellement ; elle demanderait une décision remplaçant une partie de D019.

### 3.4 Points d'approbation humaine

- Plan contenant un outil `billable`/`external` : avant l'étape concernée.
- Plan de correction (déjà le cas : `applyPlan` / `rejectPlan`).
- Changement de durée de scène avec ducking absolu (`needs-human`, existant).
- Validation finale de la révision : **toujours**, aucun run ne publie.

## 4. Modifications créatives localisées

### 4.1 Opérations d'édition en données

Union discriminée `editOperation`, qui **contient** les contrats existants au lieu
de les remplacer :

| Niveau | Opérations | Existant réutilisé |
|---|---|---|
| Scène | `scene.patch` | `scenePatchSchema` |
| Scène | `scene.insert`, `scene.remove`, `scene.move`, `scene.set-component` | nouveaux ; revalidation par `storyboardSchema` (ordre, chevauchement) et `normalizeComponent` |
| Média (v0.5) | `media.trim`, `media.fit`, `media.replace-asset` | scène `media` de la note v0.5 § 6 |
| Animation | `animation.patch` (entrée, rythme) ; `freeform.patch` (DSL, plus tard) | champs `animation` de la scène |
| Audio | `audio.track.patch`, `audio.track.add/remove` | `audioMixPatchSchema`, `audioChangeSchema` |
| Voix | `voice.set` (import, génération), `narration.set` | `revisionEditSchema`, `Studio.setNarration` / `generateVoice` |
| Sous-titres | `captions.cue.patch` (texte, temps), `captions.style.patch`, `captions.delivery` | `captionCueSchema`, `captionStyleSchema`, `captionDeliverySchema` |

Chaque opération cible des identifiants stables (`scn_`, `atr_`, cue) ; une
opération inexprimable reste vide et est signalée, comme aujourd'hui.

### 4.2 Graphe de dépendances des artefacts

```text
scène (texte|composant|media|freeform) ─▶ segment image de la scène ─▶ vidéo muette
          │                                                              │
          └─▶ visualTimeline (événements) ─▶ ancrages audio ─▶ mix ─────▶ mux ─▶ MP4
narration ─▶ voix ─▶ alignement/transcription ─▶ mots ─▶ cues ─┬▶ calque incrusté (image)
                                                               └▶ SRT / WebVTT
style des sous-titres ─▶ calque incrusté
```

Table d'invalidation (une opération n'invalide que ses descendants) :
`captions.cue.patch` → calque + exports, pas les segments de scène ;
`narration.set` → voix, mots, cues, mix, pas l'image (déjà vrai : `pictureKey`
ignore `narration`) ; `scene.patch` sur durée → segment, timeline, ancrages,
sous-titres de la scène et des suivantes ; `audio.track.patch` → mix et mux
seulement (déjà vrai : « image réutilisée »).

### 4.3 Cache de rendu par scène

Généraliser `reusablePicture` de « même storyboard » à « même scène » :
`sceneRenderKey = sha256(scène normalisée, format, version du composant, version
HyperFrames, version GSAP, empreinte du compositeur, sha256 des médias)`, segment
par scène puis assemblage FFmpeg (note v0.5 § 8, options (a)/(b) pour les calques
transverses, à mesurer). **Attention** : D019 refuse tout cache entre runs par
hash ; ce cache d'*artefacts* (pas de phases) demande une décision explicite qui
la complète. Les scènes réutilisées sont vérifiées par PSNR contre la parente
(régression `major` si écart), comme le QA comparatif D013.

### 4.4 Révisions et commentaires

Inchangé sur le fond : toute opération crée une révision enfant immuable ; les
commentaires (frame, plage, piste, cue) → `EditPlan` limité aux artefacts
désignés → seules les étapes des artefacts invalidés s'exécutent. Le journal
indique « réutilisé » / « rendu » par scène (comme `videoReusedFrom`).

## 5. Inspection des médias et boucle de correction

### 5.1 Faits mesurés et jugements

- **Mesures** (`deterministic`) : outils `inspect.*` (frames exactes par index,
  planche contact, PSNR, contrôles vidéo, contraste mesuré dans des zones connues
  par construction, photosensibilité, audio, calage des sous-titres, écart voix ↔
  script via transcription quand un ASR réel est installé).
- **Jugements** (IA) : `QualityEvaluator` ou `reviewFrames`, avec `analysisMode`
  honnête (`simulated`, `multimodal` seulement si des images ont été examinées).
- Les deux restent séparés dans le rapport (D015, D016) ; un jugement ne
  remplace jamais une mesure absente (`not-performed` motivé).

### 5.2 Boucle bornée

```text
exécution ─▶ mesures ─▶ (échec mesuré dans le périmètre du plan ?)
                          ├─ oui ─▶ Director propose un EditPlan correctif ─▶ validation § 3.2
                          │          ─▶ révision enfant ─▶ mesures   (tour n+1 ≤ maxCorrectionRounds)
                          └─ non ─▶ expertise indépendante ─▶ validation humaine
```

- Déclencheur automatique : **mesures** seulement, comme la correction automatique
  actuelle (`studio.ts:672`, au plus `maxAutoFixAttempts`). Un jugement IA peut
  proposer un plan, qui attend l'humain (option à confirmer, § 9).
- Bornes : `maxCorrectionRounds` (proposé : 2), budgets du run, arrêt si le plan
  correctif touche hors du périmètre initial ou s'il n'améliore pas la mesure.
- Indépendance : l'agent qui a produit ne valide jamais ; en `fake` et
  `claude-subscribe` où le même fournisseur crée et évalue, l'expertise reste
  consultative (MULTI-AGENT-ARCHITECTURE « Rôles »).
- En mode assisté, chaque tour = un export/import manuel : la boucle y est
  naturellement lente ; la borne doit rester faible.
- Fin : rapport + validation humaine obligatoire ; aucune boucle n'exporte.

## 6. Agents de développement et agents métier

| | Agents de développement | Agents métier Veyra |
|---|---|---|
| Qui | Session Claude Code de l'utilisateur, sous-agents, `/route` (Opus planifie, Codex écrit), skills `.agents/skills` | Director, Motion, Audio, Review, QA Expert (`agentIdSchema`, `production.ts:6`) |
| Agissent sur | Le dépôt (code, docs, tests) | Une production : briefs, révisions, artefacts d'un projet |
| Configuration | `AGENTS.md`, `CLAUDE.md`, `.agents/skills/*`, `.claude/settings.json`, configuration globale (`/route`) | `packages/ai` (consignes, schémas), `config/*.yaml`, `models.json`, catalogue d'outils versionné |
| Outils | Outils Claude Code (fichiers, shell) sous les permissions de la session | Uniquement le catalogue Veyra, validé, sans shell ni accès fichiers libre |
| Exécution de code | Oui, dans le dépôt, avec revue | Jamais de code produit par un modèle (sauf future option C, § 1.4) |

Points de contact, à garder étanches : `/veyra-assisted-task` est une session de
développement qui **joue** un fournisseur métier ; elle n'écrit que
`result.json` et n'exécute rien (D010). Les skills GSAP/Three.js/FFmpeg aident
le développeur à écrire des composants ou des outils ; ils n'entrent jamais dans
le pipeline (SKILLS-STRATEGY § 9). Le catalogue d'outils métier n'est pas un
serveur MCP pour Claude Code ; s'il le devenait, ce serait une décision séparée.

## 7. Extensibilité sans dépendance obligatoire à un fournisseur

- **JSON Schema neutre** : les descripteurs exposent `z.toJSONSchema` ; tout
  fournisseur capable de sortie structurée peut produire un `EditPlan`. Aucun
  type propre à Anthropic dans le contrat.
- **`fake` complet** : chaque outil a un chemin `fake` ou une exécution pure, et
  le planificateur `fake` couvre les tests E2E sans clé (comme aujourd'hui).
- **`claude-subscribe`** : un `kind` assisté de plus ; même limites (1 Mo,
  schéma, ids filtrés, décision humaine) ; aucune exécution côté Claude Code.
- **Moteurs optionnels** : sonde `availability` + commande d'installation
  explicite (`voice:install`, `voice:doctor` de T116) ; absence = outil listé
  « non installé » avec sa commande, jamais une erreur au démarrage.
- **Enregistrement** : ajouter un outil = un descripteur dans un tableau du
  package concerné + tests d'équivalence ; pas de plugin dynamique, pas de
  nouvelle infrastructure.
- **Sources médias** (FLORA, Google Flow) : import manuel d'abord (v0.5) ; un
  accès API serait un outil `external`/`billable`, désactivé par défaut.

## 8. Trajectoire incrémentale

| ID (proposé) | Pas | Réutilise | Critères d'acceptation |
|---|---|---|---|
| **T127** | Contrat de descripteur + descripteurs Voice / Transcription / Alignment et des fonctions déterministes existantes | `VoiceProvider`, schémas de résultats, `captions-format`, mesures `packages/video`, `z.toJSONSchema` | voir § 8.1 |
| T128 | Contrat `editOperation` (§ 4.1) et application pure sur une révision ; table d'invalidation testée | `scenePatchSchema`, `audioMixPatchSchema`, `revisionEditSchema`, `applyProposal` | Chaque opération → révision enfant valide ; parente inchangée ; invalidations conformes à la table ; corrections actuelles identiques (non-régression) |
| T129 | `EditPlan` du Director (fake, assisté, API) avec validation § 3.2 et dry-run, exécuté dans les phases existantes | `planRevisionPhases`, orchestrateur D019, `AssistedProvider` | Plan invalide / outil indisponible / permission manquante refusés avant exécution ; budget respecté ; E2E `fake` complet ; API marquée non vérifiée faute de clé |
| T130 | Cache de rendu par scène (décision préalable complétant D019) | `reusablePicture`, `compareFrames`, note v0.5 § 8 | Scènes non touchées : PSNR identique à la parente ; temps de rendu mesuré vs rendu complet ; calques transverses tranchés par mesure |
| T131 | DSL de composition contraint (POC, une primitive `text` + `shape` + tweens) | `tweenSchema`, `compose.ts`, `hyperframes check`, `entry-state.slow.test.ts` | Entrées injectées refusées ; rendu identique au pixel sur deux exécutions ; seek dans le désordre correct (T095) ; `check` sans erreur |
| v0.5 | Scène `media`, import FLORA/Flow manuel | note v0.5 | Critères de la note v0.5 § 10 |

### 8.1 Forme proposée de T127

- `packages/schemas/src/tools.ts` : `toolDescriptor` (métadonnées en Zod :
  `id`, `version`, `description`, `effects`, `cost`, `permission`,
  `determinism`), `toolCall`, et le type TS liant schémas d'entrée/sortie et
  exécuteur.
- `packages/audio` : interfaces `TranscriptionProvider` et `AlignmentProvider`
  calquées sur `VoiceProvider` (`available()`, `transcribe` / `align`), `fake`
  conforme aux schémas existants, stubs `local-asr` et `ctc` indisponibles avec
  `installHint` ; `asr-approx` et `scene-fallback` déclarés comme outils de mots
  (§ 1.2), sans modifier `alignmentResultSchema`.
- Descripteurs pour `voice.*`, `transcription.*`, `alignment.*`, `captions.*`,
  `inspect.*`, `composition.compose`, `motion.component.*`.
- Pas d'appel du catalogue par un modèle, pas de changement de prompt, d'UI ni
  de migration.
- Critères : (1) chaque descripteur convertible par `z.toJSONSchema` et testé ;
  (2) exécuter via le descripteur donne le même résultat que l'appel direct
  (`fake` voice, import, `sceneFallbackWords`, `groupCaptions`, `quantizeCues`,
  `toSrt`) ; (3) sans moteur, `local-tts`, `local-asr`, `ctc` sont listés
  indisponibles avec leur commande, sans erreur ; (4) un résultat `fake` reste
  `simulated` ; (5) `pnpm test`, `pnpm check`, `pnpm lint` réussis, `test:slow`
  inchangé.

### 8.2 À ne pas construire maintenant

- Nouvelle hiérarchie d'agents, bus de messages, file distribuée, worker séparé.
- Boucle agentique serveur ou Claude Agent SDK (D007), MCP métier.
- Exécution de code généré par un modèle (option C) et Three.js en production.
- Appels FLORA/Google, TTS/ASR payants, téléchargement implicite de modèles.
- Découverte dynamique de plugins ; budget monétaire tant qu'aucun outil
  `billable` n'est activé.
- Phase générique `tool` par étape (sauf besoin démontré, § 3.3).

## 9. Risques et questions ouvertes

**Risques**

- Plans IA souvent invalides ou trop larges : la validation les refuse, mais
  l'expérience peut se dégrader. Mesure à prévoir sur `qa/reference` étendu.
- Dérive de complexité : le catalogue peut devenir une seconde API à maintenir ;
  le limiter aux fonctions effectivement planifiées.
- Mode assisté : chaque planification et chaque tour de correction = une étape
  manuelle ; la vision « autonome » y est limitée par construction (D010).
- Cache par scène : clé incomplète ⇒ réutilisation fausse ; d'où la vérification
  PSNR systématique.
- Déterminisme : dépend des versions figées d'HyperFrames, GSAP et Chrome ;
  licences HyperFrames et GSAP encore « à vérifier pour redistribution ».
- Indépendance de la QA affaiblie en `fake`/`claude-subscribe` (même fournisseur).
- Option C : lecture de fichiers locaux par la composition tant que la racine
  reste montée en lecture.

**Questions pour l'utilisateur**

1. Valider le principe « plan comme données » plutôt qu'une boucle d'outils
   multi-tours (et donc garder D007), au moins jusqu'à T129 ?
2. Composition originale : DSL contraint d'abord (B), code sandboxé plus tard
   (C) ou jamais ?
3. Boucle de correction : déclenchement automatique sur mesures seulement, ou
   aussi sur jugement IA ? Valeur de `maxCorrectionRounds` ?
4. Cache par scène : accepter une décision qui complète D019 (cache
   d'artefacts entre révisions) ?
5. Outils `billable`/`external` : autorisation par appel uniquement, ou plafond
   par run en plus ?
6. Mettre à jour le PRD (exclusions « rushes, voix off, génération externe ») et
   remplir ROADMAP pour refléter la vision ?
7. Numérotation : T127–T131 vous conviennent-ils, et T127 doit-il précéder ou
   suivre T116 (installation des moteurs) ?
