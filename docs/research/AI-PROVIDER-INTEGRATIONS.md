# Intégrations du fournisseur IA : abonnement Claude, Claude Code CLI, Agent SDK, clé API

- Date de consultation de toutes les sources : 2026-11-04
- Auteur : Research Analyst (recherche documentaire seule ; rien installé, téléchargé ni exécuté)
- Contexte : décision [D010](../DECISIONS.md) (`claude-subscribe` en mode assisté uniquement).
  Question : existe-t-il une voie **officiellement autorisée** pour supprimer la
  manipulation manuelle (export, `/veyra-assisted-task`, import de `result.json`) ?
- Légende : **AUTORISÉ** = explicitement autorisé ; **INTERDIT** = explicitement
  interdit ; **AMBIGU** = non documenté ou ambigu. Une intégration qui fonctionne
  techniquement n'est pas pour autant autorisée.

## 1. Sources consultées

| # | Page | URL | Accès |
|---|---|---|---|
| S1 | Run Claude Code programmatically (headless) | https://code.claude.com/docs/en/headless | OK |
| S2 | CLI reference | https://code.claude.com/docs/en/cli-reference | OK |
| S3 | Agent SDK overview | https://code.claude.com/docs/en/agent-sdk/overview | OK |
| S4 | Agent SDK quickstart | https://code.claude.com/docs/en/agent-sdk/quickstart | OK |
| S5 | Agent SDK structured outputs | https://code.claude.com/docs/en/agent-sdk/structured-outputs | OK |
| S6 | Legal and compliance (Claude Code) | https://code.claude.com/docs/en/legal-and-compliance | OK |
| S7 | Authentication (Claude Code) | https://code.claude.com/docs/en/authentication | OK |
| S8 | Consumer Terms of Service (en vigueur le « Oct 8, 2025 ») | https://www.anthropic.com/legal/consumer-terms | OK (extraits partiels, l'outil limite la longueur des citations) |
| S9 | Usage Policy (affiche « Effective Nov 12, 2026 ») | https://www.anthropic.com/legal/aup | OK (extraits partiels) |
| S10 | Help center : Use the Claude Agent SDK with your Claude plan | https://support.claude.com/en/articles/15036540 | OK (corps partiel : seules les deux notes datées ont pu être lues) |
| S11 | Help center : Use Claude Code with your Pro, Max, or Ultra plan | https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan | OK (date affichée : « Updated this week ») |
| S12 | Help center : Monthly API credits for Max, Ultra, and Team plans | https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans | OK |

Non consultés : Commercial Terms (seulement référencées par S3/S6), Trademark Guidelines,
grille tarifaire API. Les prix API ne sont donc pas chiffrés ici : **Non vérifié**.

Limite d'outil : la page S9 indique une date d'effet au 2026-11-12, postérieure à la
consultation ; la version actuellement en vigueur n'a pas été lue (lien « version
history » non ouvert). S8 et S9 n'ont été lues qu'au travers d'extraits courts.

## 2. Claude Code CLI non interactif (`claude -p`) — capacités utiles

Faits techniques (ne valent pas autorisation, voir § 4) :

| Option | Constat | Source |
|---|---|---|
| `-p` / `--print` | « Add the `-p` (or `--print`) flag to any `claude` command to run it non-interactively. » Code de sortie 0 / non nul. | S1 |
| `--output-format json\|stream-json` | « `json`: structured JSON with result, session ID, and metadata » ; « `stream-json`: newline-delimited JSON for real-time streaming » ; le JSON inclut `total_cost_usd` (« client-side estimates »). | S1 |
| `--json-schema` | **Existe.** « Get validated JSON output matching a JSON Schema after the agent completes its workflow (print mode only). » Résultat dans `structured_output` ; « If a run ends without valid structured output [...] the response has no `structured_output` field. » ; `format` « doesn't enforce it ». | S1, S2 |
| `--max-turns` | « Limit the number of agentic turns (print mode only). No limit by default. » | S2 |
| `--allowedTools` | « Use `--allowedTools` to let Claude use certain tools without prompting. » Syntaxe des règles de permission. | S1 |
| `--permission-mode` | `auto`, `dontAsk`, `acceptEdits` ; « With Claude Code v2.1.302 or later, `claude -p` runs start in Manual mode when nothing sets a permission mode. » `dontAsk` « denies every call that would otherwise prompt ». | S1 |
| `--permission-prompts none` | Pour exécutions sans humain ; requiert v2.1.259+. | S1 |
| `--bare` | **Existe.** Ignore hooks, skills, plugins, MCP, CLAUDE.md ; « `--bare` is the recommended mode for scripted and SDK calls ». **Mais** : « bare mode doesn't use your subscription login » et « In bare mode, Claude Code never reads OAuth credentials or the system keychain. » | S1 |
| `--max-budget-usd`, `--no-session-persistence`, `--strict-mcp-config`, `--setting-sources` | Existent (S2). `--no-session-persistence` : « sessions are not saved to disk ». | S2 |

Point de sécurité : « Without `--bare`, a `-p` session runs the hooks in a project's
`.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder
you've never trusted. » (S1). Une exécution avec abonnement ne peut pas utiliser
`--bare` ; il faudrait donc un répertoire de travail neutre et `--setting-sources`,
`--strict-mcp-config` pour éviter de charger la config du dépôt Veyra.

Agent SDK TypeScript : `outputFormat: { type: "json_schema", schema }`, re-prompt en
cas d'écart (« the SDK validates the output against it, re-prompting on mismatch »),
erreur `error_max_structured_output_retries` ; schémas en draft-07, Zod via
`z.toJSONSchema(schema, { target: "draft-7" })` (S5). Compatible avec les contrats Zod
existants de Veyra (constat, non testé).

## 3. Agent SDK : authentification

- Méthode documentée : clé API. « Get an API key from the Claude Console, then set it
  as an environment variable » ; fournisseurs tiers : Bedrock, Claude Platform on AWS,
  Google Cloud's Agent Platform, Microsoft Foundry (S4).
- **INTERDIT (sauf accord préalable)** pour un produit tiers : « Unless previously
  approved, Anthropic does not allow third party developers to offer claude.ai login
  or rate limits for their products, including agents built on the Claude Agent SDK.
  Use the API key authentication methods described in the Quickstart instead. » (S3, S4)
- S6 : « Developers building products or services that interact with Claude's
  capabilities, including those using the Agent SDK, should use API key authentication
  through Claude Console or a supported cloud provider. »
- Conditions : « Use of the Claude Agent SDK is governed by Anthropic's Commercial
  Terms of Service » (S3).
- Constat d'existence (pas une autorisation) : l'aide officielle reconnaît l'usage du
  SDK connecté à un plan : « when you're signed in with your Claude plan, the Claude
  Agent SDK and `claude -p` still draw from your subscription limits » (S10, note du
  2026-10-07) ; « Claude Agent SDK, `claude -p`, and third-party app usage still draw
  from your subscription limits » (S10, note du 2026-06-15, qui suspend « the
  previously-announced changes to Claude Agent SDK usage »). Le reste du corps de S10
  n'a pas pu être lu : **Non vérifié** s'il précise un cadre d'usage personnel.
- Marque (S3) : autorisé « "Claude Agent" », « "{YourAgentName} Powered by Claude" » ;
  non permis « "Claude Code" or "Claude Code Agent" ». Sans objet tant que Veyra n'est
  pas distribué, mais à respecter dans l'UI.

## 4. Abonnement Pro/Max et automatisation

### Textes généraux

- Conditions grand public pour Free/Pro/Max/Ultra : « Consumer Terms of Service - for
  Free, Pro, Max, and Ultra users » (S6).
- **INTERDIT par défaut, avec exceptions** : il est interdit, « Except when you are
  accessing our Services via an Anthropic API Key or where we otherwise explicitly
  permit it », « to access the Services through automated or non-human means, whether
  through a bot, script, or otherwise. » (S8, section 3). La question est donc de savoir
  si Anthropic « explicitly permit[s] » le script en question.
- **INTERDIT** : partage d'identifiants : « You may not share your Account login
  information, Anthropic API key, or Account credentials with anyone else » (S8).
- Limites prévues pour un usage ordinaire : « Advertised usage limits for Pro, Max, and
  Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK. » (S6)
- OAuth : « intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team,
  and Enterprise subscription plans and is designed to support ordinary use of Claude
  Code and other native Anthropic applications. » (S6)
- **INTERDIT** (développeurs tiers) : « Anthropic does not permit third-party developers
  to offer Claude.ai login into their own applications, or to route requests through
  Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover,
  developers may not collect, store, or intermediate Claude.ai credentials or session
  tokens — sign-in to a Claude account must complete through Anthropic's own flow. » (S6)
- **AUTORISÉ** (titulaire lui-même, binaire non modifié) : la restriction ne
  « prevent an end user from signing in to the unmodified Claude Code binary with
  their own Claude subscription, including where a platform hosts Claude Code » (S6).
- Usage Policy (version affichée, effet 2026-11-12) : **INTERDIT** « Resell, proxy, or
  otherwise provide access to Claude through unauthorized means », la même puce visant
  aussi les « services that route requests through consumer subscriptions » (S9, section
  « Do Not Abuse Our Platform »). Phrase complète non lue (limite d'outil) : portée exacte
  **Non vérifiée**.
- Application : « Anthropic reserves the right to take measures to enforce these
  restrictions and may do so without prior notice. » (S6)

### Distinction demandée

| Cas | Statut | Justification |
|---|---|---|
| Titulaire qui lance lui-même `claude` / `/veyra-assisted-task` (mode A) | **AUTORISÉ** | Usage ordinaire du binaire natif (S6). |
| Scripts personnels appelant `claude -p` avec l'abonnement | **AMBIGU, toléré de fait** | S7 décrit `CLAUDE_CODE_OAUTH_TOKEN` : « Use this for CI pipelines and scripts where browser login isn't available » ; S10 : `claude -p` « still draw[s] from your subscription limits ». Aucune phrase ne dit « autorisé dans une application ». S8 interdit l'accès scripté sauf permission explicite. |
| Appli personnelle (serveur local Veyra) lançant `claude -p` | **AMBIGU** | Binaire non modifié, titulaire unique, pas d'intermédiation (S6 ne l'interdit pas) ; mais S6 réserve l'OAuth à « native Anthropic applications » et S9 vise les « services that route requests through consumer subscriptions ». |
| Produit distribué à des tiers offrant le login claude.ai | **INTERDIT** | S3, S6. |
| Produit distribué où chaque utilisateur lance le binaire Claude Code non modifié avec son propre abonnement | **AUTORISÉ sous conditions** | « Each end user must authenticate with their own [...] Claude subscription plan credentials » ; binaire non modifié ; Commercial Terms requises (S6). |
| Partage d'identifiants | **INTERDIT** | S8. |
| Extraction / stockage par l'appli de jetons OAuth ou de session | **INTERDIT** pour un développeur tiers (« may not collect, store, or intermediate », S6) ; pour le titulaire qui stocke son propre jeton : **AMBIGU**. | S6 |

## 5. `ANTHROPIC_API_KEY` vs `CLAUDE_CODE_OAUTH_TOKEN` / `claude setup-token`

- `claude setup-token` : « Generate a long-lived OAuth token for CI and scripts. [...]
  Requires a Claude subscription. » (S2) ; « generate a one-year OAuth token » ; « This
  token authenticates with your Claude subscription and requires a Pro, Max, Ultra,
  Team, or Enterprise plan. It can only make model requests » (S7).
- Usage prévu : « For CI pipelines, scripts, or other environments where interactive
  browser login isn't available » (S7). C'est le texte le plus proche d'une permission
  explicite d'accès scripté avec abonnement, mais il ne mentionne pas les applications.
- Restriction : « Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`. » (S7)
- Priorité : `ANTHROPIC_API_KEY` passe avant `CLAUDE_CODE_OAUTH_TOKEN`, lui-même avant le
  login `/login` ; « In non-interactive mode (`-p`), the key is always used when
  present. » (S7). Risque : une clé présente dans l'environnement du serveur bascule
  silencieusement la facturation vers l'API (S11 : « resulting in API usage charges
  rather than using your subscription's included usage »).
- `ANTHROPIC_API_KEY` : seule méthode présentée par le quickstart du SDK (S4) ; les
  restrictions S6 « [do] not restrict how customers provision and manage their own API
  keys ».
- GitHub Actions : S7 cite GitHub Actions parmi les surfaces lisant `ANTHROPIC_API_KEY` ;
  S12 précise que l'action compte comme usage Claude Code. Pas pertinent pour Veyra.

## 6. Limites, facturation, extra usage

- Limites partagées : « These limits are shared across Claude and Claude Code » ;
  « Pro and Max plans have a five-hour session limit and a weekly limit. » (S11)
- Dépassement : l'aide parle de « usage credits » (et non « extra usage ») à activer pour
  continuer après la limite (S11). Tarif : **Non vérifié**.
- Crédits API mensuels (S12) : Max 100 USD, Ultra 200 USD par mois (selon S12) ; Pro non
  éligible (S12 ne liste que Max, Ultra, Team). « API credits cover `claude -p` and the
  Claude Agent SDK when you run them yourself with an API key. » ; « Doesn't roll
  over. » ; non utilisables pour l'« Interactive Claude Code » ni l'extra usage. Une seule
  organisation Console liée.
- Applications appelant Claude Code en arrière-plan : aucune règle propre trouvée au-delà
  de S6 (« preinstalling or running Claude Code in your products or services [...]
  requires agreeing to our Commercial Terms »). Pour une appli personnelle non
  distribuée : **AMBIGU**.

## 7. Matrice de décision

| Option | Conformité | Citation clé | Coût | Risques |
|---|---|---|---|---|
| **A** Mode assisté actuel (D010) | **AUTORISÉ** | « signing in to the unmodified Claude Code binary with their own Claude subscription » (S6) | Inclus dans l'abonnement (limites 5 h / hebdo, S11) | Friction manuelle ; aucun risque contractuel identifié. |
| **B** Serveur Veyra lance `claude -p` avec le login abonnement | **AMBIGU** | S8 interdit l'accès « through automated or non-human means » sauf permission explicite ; S10 reconnaît que `claude -p` puise dans l'abonnement ; S9 vise les « services that route requests through consumer subscriptions » | Inclus dans l'abonnement | Sanction « without prior notice » (S6) ; pas de `--bare` possible (OAuth non lu, S1) donc chargement des hooks/MCP du répertoire ; bascule silencieuse en facturation API si `ANTHROPIC_API_KEY` présent (S7). |
| **C** Agent SDK avec abonnement | **INTERDIT pour un produit**, **AMBIGU** pour usage strictement personnel | « does not allow third party developers to offer claude.ai login [...] including agents built on the Claude Agent SDK » (S3) ; « should use API key authentication » (S6) | Inclus dans l'abonnement | Contredit directement la doc du SDK ; risque le plus élevé. |
| **D** Agent SDK ou Messages API avec clé API | **AUTORISÉ** | « Use the API key authentication methods described in the Quickstart » (S3/S4) ; S8 excepte l'accès « via an Anthropic API Key » | Facturé à l'usage (tarifs Non vérifiés) ; abonnés Max/Ultra : crédits mensuels de 100/200 USD couvrant « `claude -p` and the Claude Agent SDK when you run them yourself with an API key » (S12) | Coût variable (borner avec `--max-budget-usd`, S2) ; garde de la clé (déjà couverte par la règle « ne jamais journaliser `ANTHROPIC_API_KEY` »). |
| **E** `claude setup-token` + `CLAUDE_CODE_OAUTH_TOKEN` | **AMBIGU (pente autorisée pour scripts)** | « Use this for CI pipelines and scripts where browser login isn't available » (S7) | Inclus dans l'abonnement | Mêmes risques que B ; Veyra deviendrait dépositaire d'un jeton d'un an (S6 : « may not collect, store, or intermediate [...] session tokens » pour un tiers) ; incompatible avec `--bare` (S7). |

## 8. Recommandation et repli

1. **Recommandé : D**, via le fournisseur `anthropic-api` déjà présent. C'est la seule
   voie automatique **explicitement autorisée**. Si l'utilisateur a un plan Max ou Ultra,
   lier une organisation Console fait couvrir cet usage par les crédits mensuels (S12),
   ce qui limite l'écart de coût avec l'abonnement. Si Veyra veut le comportement agent
   de Claude Code (outils, `--json-schema`), utiliser `claude --bare -p ... --json-schema`
   ou l'Agent SDK avec `outputFormat`, toujours avec la clé API.
2. **Repli : A** (D010 inchangé) pour qui ne veut pas de facturation API.
3. **B / E** : ne pas implémenter sans une confirmation écrite d'Anthropic (S6 :
   « For questions about permitted authentication methods for your use case, please
   contact sales »). Toute demande à Anthropic est une transmission à un tiers et
   relève de l'utilisateur.
4. **C** : écarté.

## 9. Plan d'installation proposé (non exécuté)

Pour D avec l'Agent SDK (optionnel ; le fournisseur Messages API existant suffit pour
du JSON validé par Zod) :

1. Décision à consigner dans `docs/DECISIONS.md` (nouvelle décision, D010 conservée pour A).
2. `pnpm add @anthropic-ai/claude-agent-sdk` dans le seul paquet serveur concerné (le SDK
   embarque un binaire natif via dépendances optionnelles, S4 ; mettre à jour la section
   dépendances et licences d'`ARCHITECTURE.md`).
3. `ANTHROPIC_API_KEY` lue côté serveur uniquement ; options `outputFormat` (schéma Zod
   converti en draft-07), `allowedTools: []` ou liste minimale, `permissionMode`
   restrictif, budget borné.
4. Tests avec `VEYRA_AI_PROVIDER=fake` ; aucun test réel sans clé de l'utilisateur.

## 10. Risques transverses

- Documentation très mouvante : S10 et S12 datent d'octobre 2026, S9 change le
  2026-11-12. Revérifier avant toute décision.
- Lecture partielle de S8, S9 et S10 : les phrases complètes n'ont pas pu être
  extraites ; ne pas citer au-delà des extraits ci-dessus.
- Exécution `claude -p` sans `--bare` dans le dépôt Veyra : chargement de
  `.claude/settings.json`, hooks et `.mcp.json` sans dialogue de confiance (S1).
- Licences : SDK régi par les Commercial Terms (S3) ; licence logicielle du paquet
  npm (fichier LICENSE) **Non vérifiée** ; pas de poids ni de jeu de données en jeu.
