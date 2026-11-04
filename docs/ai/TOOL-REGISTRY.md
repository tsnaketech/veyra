# Registre des capacités (outils des agents métier)

Statut : **proposition du 2026-11-03** ; registre et premiers outils **implémentés le 2026-11-04** (T127,
§ 3 bis). Architecture :
[AGENT-ARCHITECTURE](AGENT-ARCHITECTURE.md). Un outil n'existe que s'il a un
exécuteur Veyra ; un skill Claude Code n'est jamais un outil runtime.

## 1. Principes

- Les outils sont **déclarés dans le code** (jamais dans un contenu, un prompt ou un
  commentaire) ; les outils autorisés d'une phase sont fixés par le plan validé.
- Arguments : **identifiants** (`prj_`, `rev_`, `scn_`, `ast_`, `cue_`…) et valeurs
  bornées, jamais de chemin ni d'argv fourni par le modèle ; chemins résolus par
  `ProjectStorage`/`safePath`.
- Exécution par un **exécuteur unique** (T132) : binaires en liste blanche, argv
  construit par l'outil, environnement minimal, prlimit, délai mural, sorties bornées,
  bwrap sans réseau pour tout code non fiable.
- Chaque appel produit une **enveloppe persistée** (modèle D019) et un **manifeste
  d'artefacts**.
- Un outil indisponible répond par une sonde `available()` explicite ; jamais de repli
  silencieux vers un simulateur (modèle `VoiceProvider`).

## 2. Contrat d'un outil

```ts
// Proposé ; contrat réel : packages/schemas/src/tools.ts (T127, § 3 bis)
interface ToolDescriptor<I, O> {
  id: string;                    // "captions.export", stable ; version incrémentée si incompatible
  version: number;
  description: string;           // FR, pour l'agent et l'interface
  input: ZodType<I>;             // exporté en JSON Schema (z.toJSONSchema) pour l'usage d'outils
  output: ZodType<O>;
  requires: string[];            // prérequis : "ffmpeg", "bwrap", "chrome", "engine:piper"…
  capabilities: string[];        // ce que l'outil sait faire, pour le choix du Director
  permission: PermissionClass[]; // § 4 ; cumulables
  sideEffects: "none" | "artefacts" | "revision" | "external";
  network: "none" | "pinned-destination";
  cost: { kind: "free" | "local-cpu" | "billable"; estimate?: string };
  limits: { timeoutMs: number; cpuSeconds?: number; outputBytes?: number };
  produces: string[];            // types d'artefacts : "mp4", "srt", "vtt", "wav", "png", "json"
  validation: string[];          // contrôles appliqués au résultat (Zod, ffprobe, sha256, QA)
  deterministic: boolean;        // même entrée + mêmes versions → même sortie
  available(): Promise<{ ok: boolean; reason?: string; installHint?: string }>;
  run(input: I, ctx: ToolContext): Promise<O>;
}
```

Appel (`ToolInvocation`) et résultat (`ToolResult`) réutilisent l'enveloppe
`agentResultSchema` : `id`, `agent`, `phase`, `revisionId`, `provider`,
`provenance.inputHash`, `warnings`, `errors`, `validation`, plus `toolId`,
`toolVersion`, `durationMs`, `cost`, `artefacts: { kind, path (relatif au projet),
sha256 }[]`, `simulated`.

## 3. Catalogue initial

Statut : **réel** (exécuteur et test réel), **simulé** (sortie de démonstration
étiquetée), **bouchon** (déclaré, toujours indisponible), **à créer**.

| Outil | Statut | Implémentation existante | Permission | Prérequis |
|---|---|---|---|---|
| `motion.component.list` / `.build` | réel | `motionComponents`, `buildComponentScene` | read-only | — |
| `composition.compose` | réel | `compose()` (+ calque de sous-titres) | local-compute | — |
| `composition.check` | réel | `HyperFramesEngine.check` (bwrap) | local-compute | bwrap, chrome |
| `render.hyperframes` | réel | `HyperFramesEngine.render` (bwrap, prlimit) | writes-revision-artefacts | bwrap, chrome |
| `composition.dsl` | à créer (T131) | — | local-compute | — |
| `composition.generated-code` | **refusé** (§ 5) | — | generated-code-execution | sandbox durcie |
| `inspect.probe` | réel (whitelist à ajouter, T132) | `probe` | read-only | ffprobe |
| `inspect.frames` | réel | `extractFramesByIndex`, `extractFrameByIndex` | local-compute | ffmpeg |
| `inspect.snapshot` | à créer | test uniquement (`snapshot --at`) | local-compute | bwrap, chrome |
| `qa.measure.picture` | réel | `deterministicChecks`, `renderedPictureChecks` (flashs, contraste), `compareFrames` | local-compute | ffmpeg |
| `qa.measure.audio` | réel | `audioQualityChecks`, `analyzeAudio`, `detectOnsets` | local-compute | ffmpeg |
| `qa.measure.captions` | réel (partiel) | `captionExport`, `captionPrecisionCheck` | local-compute | — |
| `qa.evaluate` | simulé (fake) ; réel non testé (API) | `QualityEvaluator` | billable (API) | fournisseur |
| `revision.patch` | réel | `applyProposal`, `reviseAudio`, `setNarration`, `setCaptionDelivery` | writes-revision-artefacts | — |
| `audio.place` / `audio.mix` | réel | `placeSceneVoice`, `resolveAudioComposition`, `mixToWav`, `muxAudio` | writes-revision-artefacts | ffmpeg, prlimit |
| `voice.import` | réel | `probeAudio`, `importedVoiceResult`, `Studio.importVoice` | writes-revision-artefacts | ffmpeg |
| `voice.fake` | simulé | `voiceProvider('fake')` | local-compute | ffmpeg |
| `voice.local-tts` | bouchon (T117) | `voiceProvider('local-tts')` | local-compute | engine:piper |
| `transcription.local-asr` | bouchon (T118) | schéma `transcriptionResultSchema` seul | local-compute | engine:whisper.cpp |
| `alignment.ctc` | bouchon (T119a/T119) | schéma `alignmentResultSchema` seul | local-compute | engine à choisir |
| `captions.build` | réel (temps `scene`) | `buildFallbackCaptions`, `refreshCaptions` | read-only | — |
| `captions.quantize` / `.export` | réel | `quantizeCues`, `toSrt`, `toWebVtt` | writes-revision-artefacts | — |
| `ffmpeg.trim` / `.concat` / `.crop` / `.speed` / `.transition` | à créer | `ffmpeg-skill` n'est **pas** utilisable au runtime | writes-revision-artefacts | ffmpeg, prlimit |
| `media.import` (vidéo, image) | à créer (v0.5) | modèle `probeAudio` | writes-revision-artefacts | ffmpeg |
| `generative.flora.*` | à créer (v0.5) | note v0.5 | network-external + billable | autorisation |
| `generative.google-flow` | import manuel seulement | note v0.5 (pas d'API Flow documentée) | writes-revision-artefacts | — |
| `three.scene` | absent (T103 POC) | — | generated-code-execution | décision |

## 3 bis. Implémentation (T127, 2026-11-04)

Contrat : `packages/schemas/src/tools.ts` (`permissionClassSchema`, `toolMetaSchema`,
`toolErrorSchema`, `toolArtefactSchema`, `toolResultSchema`). Registre :
`apps/studio/src/lib/server/tools/registry.ts` (`defineTool`, `createToolRegistry` →
`list()`, `invoke(id, entrée, { grants })`, `history` en mémoire) ; outils :
`apps/studio/src/lib/server/tools/tools.ts` ; registre Studio : `studioToolRegistry(ctx)`
(`tools/index.ts`), non branché sur une route (boucle T129).

Ordre d'`invoke` : outil inconnu → `unknown-tool` ; entrée non JSON ou refusée par Zod →
`invalid-input` (aucun processus) ; permission absente des `grants` →
`permission-denied` ; `available()` → `unavailable` (+ `installHint`) ; exécution bornée
par `limits.timeoutMs` → `timeout` / `failed` (première ligne du message, sans pile,
valeurs secrètes masquées) ; sortie refusée par Zod ou plus grande que
`limits.outputBytes` → `invalid-output`. Artefacts : dossier neuf
`<prj>/tool-calls/<tcl_…>/` (jamais un dossier de révision), chemin relatif à la racine
de stockage et sha256. L'enveloppe `agentResultSchema` (agent, phase) est ajoutée par la
boucle (T129), pas par le registre.

| Outil | Statut | Fonction réutilisée | Permissions | Preuve |
|---|---|---|---|---|
| `media.inspect` | réel | `probe` (`@veyra/video`) | read-only, local-compute | `tools.test.ts` (b, e) |
| `media.frame` | réel | `extractFrameByIndex` | local-compute, writes-revision-artefacts | `tools.test.ts` (b, c, e) |
| `scene.patch` | réel (aucune révision créée) | `applyProposal` | read-only | `tools.test.ts` (g) |
| `audio.track.update` | réel | `Studio.reviseAudio` (révision enfant) | writes-revision-artefacts | `tools.test.ts` (d, g, e) |
| `captions.build` | réel (temps `scene`, approximatifs) | `buildFallbackCaptions`, `captionPrecisionSummary` | read-only | `tools.test.ts` |
| `captions.export` | réel (cadence et frames mesurées de `revision.media`) | `quantizeCues`, `toSrt`, `toWebVtt` | read-only | `tools.test.ts` |
| `composition.check` | réel | `VideoEngine.check` (HyperFrames, bwrap) | local-compute | `tools.slow.test.ts` (h) |
| `voice.local-tts` | bouchon | `voiceProvider('local-tts').available()` | local-compute | `registry.test.ts` (f) |
| `transcription.local-asr` | bouchon | — | local-compute | `registry.test.ts` (f) |
| `alignment.ctc` | bouchon | — | local-compute | `registry.test.ts` (f) |

Les autres lignes du § 3 restent au statut indiqué : non enregistrées dans le registre.

### Garde-fous ajoutés après la revue indépendante (2026-11-04)

- **Portée projet** : un registre sert un seul projet (`ToolContext.projectId`) ; les outils
  lisent leurs révisions par `ctx.revision(id)`, qui refuse (`permission-denied`) toute
  révision d'un autre projet.
- **Entrées bornées** : 256 Kio de JSON au plus ; une entrée non JSON, trop grande ou trop
  profonde est refusée (`invalid-input`) avant toute analyse, jamais levée en exception.
- **Permissions validées à l'exécution** (`permissionClassSchema`), sans correspondance de
  sous-chaîne.
- **Délai** : seul un outil sans effet de bord est `retryable` ; pour les autres, le message
  précise que l'opération peut se poursuivre (pas encore d'`AbortSignal` dans l'exécuteur).
- **Messages d'erreur** : secrets masqués avant troncature avec la règle de l'exécuteur
  (`isSecretEnvKey`), racine des projets remplacée par `<projets>`.

Limites connues : `requires` reste déclaratif (un binaire absent donne `failed`, pas
`unavailable`) ; `ToolResult` ne porte pas encore de coût ; historique en mémoire non borné ;
`movie=` dans un graphe lavfi construit par le code reste hors du contrôle N7 (résiduel).

## 4. Classes de permission

| Classe | Exemples | Par défaut |
|---|---|---|
| `read-only` | lire un storyboard, une révision, des mesures | autorisé selon la phase |
| `local-compute` | ffmpeg/ffprobe sous prlimit, `check`, mesures | autorisé avec limites |
| `writes-revision-artefacts` | rendu, mixage, sous-titres, nouvelle révision | autorisé dans un dossier d'artefacts neuf ; jamais sur une révision approuvée ; manifeste obligatoire |
| `generated-code-execution` | composition HTML/CSS/GSAP/Three.js écrite par l'IA | **refusé** (§ 5) |
| `network-external` | FLORA, API Google | refusé ; autorisation humaine par appel (destinataire, données sortantes), destination épinglée |
| `billable` | Anthropic, FLORA | refusé hors budget ; décrément avant l'appel ; confirmation du premier appel d'un run |

Liste de refus par défaut : shell ou argv arbitraire, binaire hors liste blanche,
réseau non déclaré, installations (`pnpm`/`pip`/`uv`, `voice:install`,
`hyperframes add`), téléchargements silencieux, appel payant automatique, secret
transmis à un agent ou à un enfant, lecture hors projet, écriture hors du dossier
d'artefacts, modification d'une révision approuvée, écriture sans manifeste, repli
`allowUnsandboxed`, `claude -p` lancé par le serveur (D010).

## 5. Garde-fous avant toute composition écrite par l'IA

Nouvelle décision requise (remplacerait D007/D017 sur ce point). Minimum :
contrôles statiques (liste blanche de balises, aucun `fetch`/`import()`/`eval`/
`iframe`/URL externe ; bibliothèques locales épinglées), CSP injectée par le
compositeur (`connect-src 'none'`), sandbox durcie (montages minimaux au lieu de
`--ro-bind / /`, HOME factice, `--unshare-all --new-session --clearenv`, sortie
séparée des rendus précédents, limite mémoire), `check`/`lint` bloquants, contrôles
T104 bloquants, validation humaine du code et du rendu, provenance (agent, modèle,
prompt, hash du code), aucune frame envoyée à un service externe sans autorisation.

## 6. Injection de consignes

Avec des outils, une injection devient une action. Contenu utilisateur et sorties
d'outils sont encapsulés et marqués non fiables ; les outils d'une phase sont fixés
par le plan, jamais par un commentaire ou un média ; arguments validés et bornés.
