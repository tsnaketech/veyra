# Workflows IA

## Fournisseurs (D010, D011)

| Id | Mode | Authentification | Capacités réelles |
|---|---|---|---|
| `fake` | direct | aucune | Règles déterministes ; tout est étiqueté « [Simulé] ». Tests uniquement. |
| `anthropic-api` | direct | `ANTHROPIC_API_KEY` (facturation API) | Storyboard, plan (images annotées jointes), revue d'images. **Non vérifié** faute de clé. |
| `claude-subscribe` | assisté | abonnement Claude via Claude Code, géré par Claude Code | Storyboard, plan et expertise QA, par export/import. Pas de revue qualitative automatique au rendu. |

Sélection : `VEYRA_AI_PROVIDER` (verrouille), sinon `/settings`, sinon
`models.json` → `defaultProvider`. `createProvider` construit exactement le
fournisseur choisi ou lève `ProviderUnavailableError` ; aucun basculement.

## Opérations

| Opération | Entrée | Sortie validée par Zod |
|---|---|---|
| Storyboard | prompt, durée visée, consignes de marque, catalogue du registre de composants | `storyboardDraftSchema` (scènes texte ou `component` validé par union discriminée) |
| Plan d'un lot | storyboard + commentaires (`frameIndex`, `timestampMs`, scène, image) | `revisionProposalSchema` (`feedbackId`, patches, `conflicts`) |
| Revue | storyboard, images PNG | constats avec `analysisMode` |
| Expertise QA (`QualityEvaluator`) | dossier de preuves : brief, storyboards, commentaires alignés, plan, mesures, images exactes | `expertReviewSchema` (verdicts, catégories, confiance, preuves, constats) — D015 |

Les consignes communes sont dans `instructions` (`packages/ai`), partagées par
l'API et le mode assisté.

## Mode assisté (`claude-subscribe`)

1. Veyra écrit `projects/<prj>/ai-tasks/<tsk>/request.json`
   (`format: veyra-ai-task/v1`, `kind`, `instructions`, `input`, `outputSchema`)
   et, pour un plan, `frames/<fdb>.png`.
2. L'utilisateur, dans **sa** session Claude Code à la racine du dépôt, lance
   `/veyra-assisted-task <dossier>` ([skill](../../.agents/skills/veyra-assisted-task/SKILL.md)),
   qui écrit seulement `result.json`, sans exécuter de commande.
3. Import automatique (surveillance serveur toutes les 2 s, fichier stable entre deux
   passages) ou « Importer le résultat » en repli, par le même `importTask` : fichier
   régulier sans lien, taille ≤ 1 Mo, JSON, schéma Zod, production et révision du
   même projet ; une erreur laisse la tâche en attente avec son message, retentée
   seulement si le fichier change. Le plan importé attend ensuite la décision humaine.

Disponibilité (`checkClaudeSubscribe`) : `claude --version`, puis
`claude auth status --json` sans variables de clé API ; seuls `loggedIn`,
`authMethod` (`claude.ai` requis) et `subscriptionType` sont gardés. Une
`ANTHROPIC_API_KEY` dans l'environnement est signalée : Claude Code l'utiliserait à
la place de l'abonnement. Les limites d'usage de l'abonnement s'appliquent dans
Claude Code ; Veyra ne les contourne pas.

## API (`anthropic-api`)

API Messages (`@anthropic-ai/sdk` 1.3.0, `client.beta.messages.parse` +
`zodOutputFormat`), modèle `models.json` → `models[0]` (`claude-opus-5-5`), effort
`medium`, repli serveur en cas de refus (`fallbacks: "default"`) — D007.

Le modèle ne produit jamais de code : seules des données structurées sont
acceptées, puis transformées de façon déterministe (`toStoryboard`,
`applyProposal`, `compose`). Les skills sont dans `.agents/skills/` (visibles par
Claude Code via `.claude/skills`).

Contrats v0.3 et rôles métier : [Architecture multi-agents](MULTI-AGENT-ARCHITECTURE.md).

## Plans dynamiques (proposition)

Statut : proposition (T129), non implémentée. Architecture :
[AGENT-ARCHITECTURE](AGENT-ARCHITECTURE.md), outils : [TOOL-REGISTRY](TOOL-REGISTRY.md).
Le Director produit un plan **en données** (un appel structuré), validé par Zod,
budgété et exécuté par l'orchestrateur D019 ; aucune séquence n'est obligatoire.

Exemple — « vidéo promotionnelle de 30 s, voix off française, animations originales,
transitions cinématographiques, sous-titres synchronisés » :

```json
{
  "creative": { "intention": "promo dynamique", "style": "cinématographique sombre", "rythme": "montée 0–10 s, preuve 10–22 s, appel 22–30 s" },
  "scenes": [
    { "id": "scn_1", "technique": "dsl", "durationMs": 6000, "narration": "Votre équipe perd 3 heures par semaine." },
    { "id": "scn_2", "technique": "component", "component": "feature-cards", "durationMs": 9000 },
    { "id": "scn_3", "technique": "media", "asset": "ast_rush1", "trim": [2000, 9000] },
    { "id": "scn_4", "technique": "component", "component": "call-to-action", "durationMs": 8000 }
  ],
  "tools": [
    { "tool": "composition.dsl", "scene": "scn_1" },
    { "tool": "ffmpeg.trim", "scene": "scn_3", "asset": "ast_rush1" },
    { "tool": "voice.local-tts", "scenes": ["scn_1", "scn_2", "scn_4"], "fallback": "ask-user" },
    { "tool": "captions.build", "timing": "best-available" },
    { "tool": "render.hyperframes", "delivery": "both" },
    { "tool": "qa.measure.picture" }, { "tool": "qa.measure.captions" }, { "tool": "qa.evaluate", "isolated": true }
  ],
  "budget": { "maxAiCalls": 3, "maxRenders": 3, "billable": "none" }
}
```

Si `voice.local-tts` est indisponible, l'outil répond « Moteur non installé » ; le
plan prévoit `ask-user` (proposer l'import d'une voix), jamais un repli silencieux
vers `voice.fake`. `composition.dsl` et `ffmpeg.trim` sont à créer (T131, outils
FFmpeg) : en attendant, le Director doit choisir une technique disponible.

Exemple de correction localisée — commentaire à 00:12 « la transition est trop
brusque, et la voix de la scène 3 est trop forte » :

1. Review → deux `EditOperation` : `{ kind: "transition", scene: "scn_3", durationMs: 600 }`
   et `{ kind: "audio-gain", track: "atr_voix3", gainDb: -4 }`.
2. Graphe d'invalidation (T128) : la transition invalide l'image des scènes 2–3 ;
   le gain n'invalide que le mix. Scènes 1 et 4, sous-titres, autres pistes : réutilisés.
3. Exécution : rendu des seules scènes touchées (cache par scène, T130 ; aujourd'hui
   l'image entière est re-rendue mais les autres artefacts sont réutilisés), remix,
   SRT/VTT re-quantifiés sur la vidéo exportée.
4. QA mesuré limité aux plages touchées + contrôles globaux bornés ; QA Expert isolé ;
   nouvelle révision, parent intact ; validation humaine.
