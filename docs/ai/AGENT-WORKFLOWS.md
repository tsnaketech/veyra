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
   qui écrit `result.json`.
3. « Importer le résultat » : taille ≤ 1 Mo, JSON, schéma Zod ; une erreur laisse la
   tâche en attente avec son message. Le plan importé attend ensuite la décision humaine.

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
