# Architecture

## État et cible

| Chemin | Rôle | État |
|---|---|---|
| apps/studio | SvelteKit 3, Svelte 5 runes, Tailwind 4 : tableau de bord, Studio (lecteur image par image `FramePlayer.svelte`), paramètres (choix du fournisseur) ; orchestrateur `src/lib/server/studio.ts` (annotations, lots, tâches assistées, QA comparatif) ; routes `/media/[revisionId]`, `/captures/[feedbackId]`, `/qa-images/[evaluationId]/[file]` | MVP + annotations |
| packages/schemas | Contrats Zod, identifiants, transitions, storyboard ; calcul des frames (`frames.ts`) | Phase 1 + frames |
| packages/config | Chargement déclaratif, validation, fusion et secrets | Phase 1 |
| config/ | Configuration versionnée et guide de marque | Phase 1 |
| apps/studio/src/lib/server/jobs | File de rendu en processus, concurrence 1 | Itération 2 |
| apps/worker | Worker isolé lors du passage multi-instance | Différé, voir D006 |
| packages/ai | Fournisseurs `fake`, `anthropic-api` (non vérifié), `claude-subscribe` (mode assisté, `assisted.ts`), détection Claude Code ; aucun basculement (D010, D011) ; `QualityEvaluator` et validation des expertises (`evaluation.ts`, D015) | MVP + fournisseurs + expertise |
| packages/core | Orchestration partagée | Non créé : l'orchestration vit dans le Studio tant qu'il n'y a pas de worker |
| packages/motion | Registre versionné de composants animés (schémas, durées, capacités, HTML échappé + animations en données, CSS, aperçus) — D017 | Motion Engine v0.2 |
| packages/audio | Validation, résolution des ancrages, mixage WAV, mux AAC et mesures déterministes — [AUDIO-PIPELINE](video/AUDIO-PIPELINE.md) | v0.3 Phase B |
| packages/video | ffprobe (fréquence rationnelle, CFR), ffmpeg, QA déterministe, extraction PNG par temps ou par index, comparaison PSNR | Itération 2 + frames |
| packages/hyperframes-adapter | Composition déterministe, CLI, sandbox et FakeEngine | Itération 2 |
| packages/storage | Chemins confinés, révisions et originaux exclusifs | Itération 2 |
| packages/feedback | Revue et corrections | Non créé : logique dans `studio.ts` et `packages/ai` (REVIEW-SYSTEM) |
| .agents/skills | Skills de développement du MVP (lien `.claude/skills`) | MVP |
| qa/reference/v1 | Jeu de référence QA versionné (cas, images réduites, résultats enregistrés) ; `pnpm qa:bench` | QA Expert v0.1 |

Workspace pnpm unique ; les packages internes exportent leur source TypeScript.
SQLite est accédé via Drizzle et better-sqlite3. Les migrations (0000 initiale,
0001 additive, D014) sont dans `apps/studio/drizzle/`. Le dépôt métier valide les entrées, synchronise les scènes
avec le storyboard et centralise les changements d’état en transactions. La
connexion active les clés étrangères. Le schéma de référence est
[PROJECT-SCHEMA](system/PROJECT-SCHEMA.md).

Le chargeur reçoit les couches dans l’ordre global → template → projet. Fusion
récursive des objets, remplacement des listes et scalaires ; defaults initiaux puis
defaults Zod pour les valeurs absentes. `locked` contient des chemins d’objets
séparés par des points ; tout changement ultérieur de leur valeur est refusé.
Les chemins manquants ne peuvent pas être verrouillés. Chaque fichier déclare
`schemaVersion: 1`. Les parsers supplémentaires sont enregistrés explicitement.

`value` est réservé à l’exécution privée. Utiliser `redacted()` avant persistance,
logs ou exposition ; les colonnes JSON de configuration ne doivent jamais recevoir
la vue contenant des secrets. Les erreurs de validation n’incluent pas les valeurs.
La page `/settings` n'expose que des vues masquées et la présence des secrets.

## Dépendances et redistribution

Versions exactes : `pnpm-lock.yaml`. Sources locales : manifests et licences des
packages installés dans `node_modules` ; conserver leurs notices lors de redistribution.

| Dépendance | Usage | Licence / contrainte |
|---|---|---|
| Svelte, SvelteKit, Tailwind CSS | Studio | MIT |
| Drizzle ORM / kit | Schéma et migrations | Apache-2.0 / MIT |
| better-sqlite3 | Pilote SQLite natif | MIT |
| Zod | Contrats et validation | MIT |
| yaml | Parsing sans exécution de code | ISC |
| Vitest, Playwright | Tests | MIT / Apache-2.0 |
| HyperFrames 0.8.214 | Moteur CLI installé | Manifest Apache-2.0, aucun fichier LICENSE livré dans le paquet npm inspecté ; **à vérifier pour redistribution** |
| @anthropic-ai/sdk 1.3.0 | Fournisseur IA réel (API Messages, D007) | Apache-2.0 |
| Plugin Claude Code `hyperframes@hyperframes` (tag v0.8.214) | Skills HyperFrames pour les agents (non versionnés, D018) | Apache-2.0 (marketplace.json) ; réinstallés, jamais redistribués |
| tsx 4.23.15 | Exécution de `pnpm qa:bench` (dev, `@veyra/ai`) | MIT |
| GSAP 3.14.2 | Animations, copie locale à la composition | Manifest « Standard 'no charge' license », en-tête renvoyant à gsap.com/standard-license ; **à vérifier pour redistribution** |

Les choix d’isolation et d’intégration IA sont dans [DECISIONS](DECISIONS.md).

## Flux des corrections

Frame choisie → « Ajouter » (brouillon SQLite + capture ffmpeg, sans IA ni rendu)
→ « Envoyer les corrections à l'IA » (lot idempotent) → fournisseur actif :
appel direct (`fake`, `anthropic-api`) ou export `request.json` / import
`result.json` (`claude-subscribe`) → plan → décision humaine → révision enfant →
rendu → QA déterministe + comparatif → expertise QA consultative (D015) →
validation humaine → export.
Détails : [REVIEW-SYSTEM](system/REVIEW-SYSTEM.md), [AGENT-WORKFLOWS](ai/AGENT-WORKFLOWS.md).
Claude Code (binaire de l'utilisateur, conditions [Anthropic](https://code.claude.com/docs/en/legal-and-compliance))
n'est jamais lancé par Veyra pour une requête modèle ; seules `claude --version` et
`claude auth status` sont exécutées pour afficher la disponibilité.

Le système requiert ffmpeg/ffprobe avec libx264 et PNG (9.0.2 présents, [install_ffmpeg](install_ffmpeg.md)), bwrap, prlimit et Chrome
Headless Shell (`hyperframes browser ensure`, dans `~/.cache/hyperframes`).
Le pipeline réel et ses limites sont dans [VIDEO-PIPELINE](video/VIDEO-PIPELINE.md),
le modèle de sandbox dans [SECURITY](SECURITY.md).

## Contrats v0.3 — phase A

Les schémas historiques sont dans `packages/schemas/src/core.ts`, réexportés par
`index.ts` ; `timeline.ts`, `audio.ts` et `production.ts` les réutilisent sans
cycle d'import. Le registre Motion fournit aussi des événements synchronisés
avec ses animations. Voir [Architecture multi-agents](ai/MULTI-AGENT-ARCHITECTURE.md).
