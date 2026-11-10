# Intégrations OpenAI : Codex avec abonnement ChatGPT (`codex-chatgpt`), Sign in with ChatGPT, API OpenAI

- Date de consultation de toutes les sources : 2026-11-04
- Auteur : Research Analyst (recherche documentaire seule ; rien installé, téléchargé,
  exécuté ni connecté)
- Méthode : identique à [AI-PROVIDER-INTEGRATIONS](AI-PROVIDER-INTEGRATIONS.md).
  Question : Veyra (serveur SvelteKit local sur 127.0.0.1, mono-utilisateur, non distribué,
  dépôt non publié à ce jour) peut-il utiliser Codex avec l'abonnement ChatGPT de son
  titulaire, sans clé API et sans manipulation manuelle par projet, **de façon
  officiellement autorisée** ?
- Légende : **AUTORISÉ** = explicitement autorisé ; **INTERDIT** = explicitement interdit ;
  **AMBIGU** = non documenté ou ambigu. La faisabilité technique ne vaut pas autorisation.
- Limite d'outil : les pages sont lues au travers d'un outil qui résume ; les passages
  entre guillemets sont ceux que l'outil a restitués comme littéraux. Ne pas citer au-delà.

## 1. Sources consultées

| # | Page | URL | Accès |
|---|---|---|---|
| O1 | Codex (accueil docs) | https://developers.openai.com/codex | Redirection 308 vers https://learn.chatgpt.com/docs (navigation seule, pas de corps) |
| O2 | Codex as a platform (blog) | https://developers.openai.com/blog/codex-as-a-platform | OK (aucune date affichée) |
| O3 | ChatGPT plan usage : Overview | https://developers.openai.com/siwc/token-sharing-open-source | OK (aucune date) |
| O4 | ChatGPT plan usage : Codex app-server | https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server | OK |
| O5 | Help center : Using Codex with your ChatGPT plan | https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan | **Inaccessible (HTTP 403)** |
| O6 | Sign in with ChatGPT (accueil) | https://developers.openai.com/siwc | OK |
| O7 | Preview limitations | https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations | OK |
| O8 | Registration and sign-in | https://developers.openai.com/siwc/token-sharing-open-source/sign-in | OK |
| O9 | Accounts and sessions | https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions | OK |
| O10 | Request a client ID | https://developers.openai.com/siwc/request-client-id | OK |
| O11 | Models and inference | https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference | OK |
| O12 | Errors and recovery | https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery | OK |
| O13 | SIWC Quickstart | https://developers.openai.com/siwc/quickstart | OK |
| O14 | Self-hosted VMs | https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms | OK |
| O15 | Token reference | https://developers.openai.com/siwc/token-sharing-open-source/token-reference | OK |
| O16 | UI/UX guidelines | https://developers.openai.com/siwc/token-sharing-open-source/ui-ux-guidelines | **Inaccessible (HTTP 404)** |
| C1 | Codex Authentication | https://developers.openai.com/codex/auth → https://learn.chatgpt.com/docs/auth (et `auth.md`) | OK via redirection 308 |
| C2 | Maintain Codex account auth in CI/CD (advanced) | https://learn.chatgpt.com/docs/auth/ci-cd-auth.md | OK |
| C3 | Non-interactive mode (`codex exec`) | https://learn.chatgpt.com/docs/non-interactive-mode | OK |
| C4 | Codex SDK | https://learn.chatgpt.com/docs/codex-sdk | OK |
| C5 | Codex SDK TypeScript (README) | https://github.com/openai/codex/tree/main/sdk/typescript | OK |
| C6 | Codex app-server | https://learn.chatgpt.com/docs/app-server | OK (page de 147 444 caractères ; 0–140 000 lus, fin non lue) |
| C7 | Config reference | https://learn.chatgpt.com/docs/config-file/config-reference | OK (page de 167 796 caractères ; lue en deux parties, des clés peuvent manquer) |
| C8 | Sandboxing | https://learn.chatgpt.com/docs/sandboxing | OK |
| C9 | Agent approvals & security | https://learn.chatgpt.com/docs/agent-approvals-security | OK |
| C10 | Codex pricing | https://learn.chatgpt.com/docs/pricing | OK |
| C11 | Sign in with ChatGPT (côté Codex/ChatGPT) | https://learn.chatgpt.com/docs/sign-in-with-chatgpt | OK |
| C12 | Dépôt openai/codex | https://github.com/openai/codex | OK |
| C13 | Releases openai/codex | https://github.com/openai/codex/releases | OK |
| A1 | Structured Outputs | https://developers.openai.com/api/docs/guides/structured-outputs | OK (0–100 000 lus) |
| A2 | Background mode | https://developers.openai.com/api/docs/guides/background | OK |
| A3 | Function calling | https://developers.openai.com/api/docs/guides/function-calling | OK |
| A4 | Images and vision | https://developers.openai.com/api/docs/guides/images-vision | OK |
| A5 | Rate limits | https://developers.openai.com/api/docs/guides/rate-limits | OK |
| A6 | SDK `openai` (openai-node) | https://github.com/openai/openai-node | OK |
| T1 | Terms of Use | https://openai.com/policies/terms-of-use/ et https://openai.com/policies/row-terms-of-use | **Inaccessibles (HTTP 403)** |
| T2 | Usage Policies | https://openai.com/policies/usage-policies/ | **Inaccessible (HTTP 403)** |
| T3 | Help center (facturation ChatGPT / API) | https://help.openai.com/en/articles/8156019-how-can-i-move-my-chatgpt-subscription-to-the-api | **Inaccessible (HTTP 403)** |

Remarques :
- Les docs Codex sous `developers.openai.com/codex/*` redirigent (308) vers
  `learn.chatgpt.com/docs/*`. Ce domaine ne figure pas dans la liste demandée ; il est
  retenu comme cible de redirection officielle émise par developers.openai.com.
- **Non lus** : Terms of Use, Services Agreement, Usage Policies, articles du help center
  (403). Aucune affirmation contractuelle générale (automatisation, scripts, partage de
  compte) n'est donc vérifiée : **Non vérifié**. C'est la principale limite de l'étude.
- Une recherche web a renvoyé des forums et blogs tiers sur la séparation des facturations ;
  ils ne sont pas officiels et ne sont pas utilisés.

## 2. Deux mécanismes distincts à ne pas confondre

1. **Codex natif connecté au compte ChatGPT du titulaire** : Veyra lancerait le binaire
   Codex non modifié (`codex exec`, SDK qui pilote ce binaire, ou `codex app-server` en
   mode `chatgpt`). L'authentification est celle de Codex lui-même (`codex login`).
   L'usage est décompté comme usage Codex du plan.
2. **Sign in with ChatGPT – ChatGPT plan usage** (« token sharing ») : Veyra s'enregistre
   comme client OAuth propre, obtient un jeton portant le scope
   `chatgpt.tokens.use.direct`, puis envoie des requêtes Responses API facturées sur le
   plan de l'utilisateur, soit directement, soit via `codex app-server` avec
   `ACCESS_TOKEN` (O4, O8). C'est le seul mécanisme qu'OpenAI décrit explicitement pour
   « Apps powered by your user's ChatGPT plan » (O6).

## 3. Faits par source

### 3.1 Sign in with ChatGPT / ChatGPT plan usage (mécanisme 2)

- Objet : « Let users sign in with ChatGPT and use their ChatGPT plan for eligible AI
  requests in your app. » (O6)
- Périmètre des docs : « These docs explain ChatGPT plan usage for open-source and
  locally hosted apps. » ; pour le reste : « If you're interested in offering it in a paid
  or remotely hosted app, complete the interest form. » (O3)
- **Éligibilité** : « Sign in with ChatGPT is currently available to selected commercial
  partners through a limited trial. » ; « ChatGPT plan usage is available to all
  open-source partners and selected private clients. » ; « Eligible ChatGPT Plus and Pro
  users can use their ChatGPT plan for AI requests in participating apps » (O13).
  « Sign in with ChatGPT is currently offered to a select group of commercial partners. »
  ; « To join the waitlist, complete the Sign in with ChatGPT interest form. » (O10).
  Côté utilisateur : « In supported apps, eligible ChatGPT Plus and Pro subscribers can
  also choose to use their ChatGPT plan for AI requests. » (C11)
- Inscription (open source) : enregistrement dynamique, « Start first-time registration
  with `client_id=dynamic_agent_client` » ; « This direct flow needs neither a client
  secret nor a partner API key. » ; callback « an HTTP loopback callback on `127.0.0.1` »,
  « Do not substitute with `localhost`. » (O8). « The open-source sign-in flow registers
  your client and issues OAuth credentials » (O13).
- Consentement et scope : « A valid ID token alone does not authorize ChatGPT plan
  usage. » ; vérifier `chatgpt.tokens.use.direct` avant toute inférence (O8). Jetons :
  « Access tokens are valid for one hour (`expires_in: 3600`). » ; « Refresh tokens are
  valid for 30 days. » (O15)
- Stockage : « Write files atomically with owner-only permissions (`0600` on Unix), and
  never commit or log them. » (O8) ; « Keep tokens out of browser storage, source
  control, logs, analytics, and support transcripts. » (O9)
- Accès limité : « This does not grant access to their ChatGPT conversations or other
  account context. » (O3)
- Limites : « For ChatGPT Plus users, the five-hour usage limit is shared across all apps
  where they use their ChatGPT plan, » « including private and open-source clients. » ;
  « The five-hour usage limit does not apply for Pro users. » (O9). « App usage counts
  toward your existing plan limits. » (C11)
- Contraintes techniques (O7) : « Set `store: false` and `stream: true`. » ; messages
  système refusés (utiliser `instructions`) ; `temperature`, `top_p`, `user`,
  `truncation` à omettre ; outils non pris en charge : « Image generation, file search,
  Code Interpreter, native computer use, hosted MCP/connectors, and Responses
  `tool_search`. » ; « Audio/video input, the Files upload API, and the transcription API
  are not supported by this flow. » ; texte, images et fichiers acceptés si le modèle les
  accepte. Structured Outputs (`text.format`) et function tools : ni listés comme
  supportés ni comme exclus : **Non vérifié**.
- Pas de bascule de facturation : « OpenAI does not silently switch the request to
  another billing path. » ; erreurs `subscription_sharing_usage_limit_exceeded` (429) et
  `subscription_sharing_user_not_eligible` (403) (O12).
- Via app-server (O4) : « Set `ACCESS_TOKEN` in the app-server child process's
  environment to that value. » ; « No separate Codex sign-in is required. » ; « only
  `completed` indicates success; `failed` and `interrupted` do not. » ; renouvellement :
  redémarrer app-server avec le nouveau jeton puis `thread/resume`. Limite : « Your app
  must refresh the OAuth token and restart app-server with the renewed access token. »
  (O7)
- Conditions contractuelles propres au programme : aucune sur les pages lues (O3, O6,
  O13) ; **Non vérifié**.

### 3.2 Codex natif avec compte ChatGPT (mécanisme 1)

- Deux modes : « Sign in with ChatGPT for subscription access » et « Sign in with an API
  key for usage-based access. » (C1)
- Recommandation officielle pour le programmatique : « Use API key authentication for
  programmatic Codex CLI workflows, such as CI/CD jobs. » ; « Don't expose Codex execution
  in untrusted or public environments. » (C1)
- Guide avancé : « This is an advanced workflow for enterprise and other trusted private
  automation. » ; « The right way to authenticate automation is with an API key. » ;
  « API keys are still the recommended option for most CI/CD jobs. » ; « Use this guide
  only if you specifically need to run the workflow as your Codex account. » (C2). Le
  guide déconseille ce flux pour les dépôts publics ou open source (C2, d'après l'outil).
- Blog plateforme (O2) : « For a script, CI job, or one-off background task, codex exec
  can run a bounded agent workflow and return structured output. » ; « For application
  code that needs to start, resume, or stream Codex tasks, the official Codex SDK provides
  a direct programmatic interface. » ; « Use Codex app-server when the agent is part of the
  product itself. » ; « model access and managed services remain separate ». Le billet ne
  parle ni d'authentification ChatGPT ni de facturation.
- Plans : « ChatGPT Work and Codex are included in your ChatGPT Free, Go, Plus, Pro,
  Business, Edu, or Enterprise plan. » ; « Local messages and cloud chats share your
  plan's usage allowance. » (C10)

### 3.3 Abonnement ChatGPT et API

- « OpenAI bills API key usage through your OpenAI Platform account at standard API
  rates. » (C1) ; « API token prices are separate from subscription usage; don't use them
  to estimate included tasks. » ; « All users may also run extra local chats using an API
  key, with usage charged at standard API rates. » (C10).
- Conclusion : l'abonnement ChatGPT **ne donne pas** d'accès gratuit par clé API ; la clé
  est facturée à part au tarif API (C1, C10). Seule exception documentée : le mécanisme 2,
  qui fait payer des requêtes Responses API éligibles par le plan, réservé aux applications
  éligibles (O3, O13). Le texte du help center (O5, T3) n'a pas pu être lu.

### 3.4 `codex exec` (C3)

- « By default, `codex exec` runs in a read-only sandbox. » ; progression sur stderr,
  message final sur stdout.
- `--json` : « `stdout` becomes a JSON Lines (JSONL) stream so you can capture every
  event Codex emits » (événements `thread.started`, `turn.completed`, `error`).
- `--output-schema` : « request a final response that conforms to a JSON Schema » ;
  `-o` / `--output-last-message` écrit le dernier message dans un fichier.
- `--ephemeral` : « Use `--ephemeral` when you don't want to persist session rollout files
  to disk » ; reprise : `codex exec resume --last` ou `codex exec resume <SESSION_ID>`.
- `--ignore-user-config` (ne charge pas `$CODEX_HOME/config.toml`), `--ignore-rules`
  (« skip user and project execpolicy `.rules` files for a controlled automation
  environment »), `--skip-git-repo-check` (à réserver à un environnement sûr).
- `--full-auto` n'est plus pris en charge (remplacé par `--sandbox workspace-write` ou
  `--approve-for-me`).
- Auth : « `codex exec` reuses saved CLI authentication by default. » ; « To use a
  different API key for a single run, set `CODEX_API_KEY` inline » ; « Do not set
  `OPENAI_API_KEY` or `CODEX_API_KEY` as a job-level environment variable ». Ordre de
  priorité entre clé d'environnement et login ChatGPT : **non documenté** (C1, C3).
- Images : le flag n'est pas sur C3 ; C5 indique « image entries are passed to the Codex
  CLI via `--image`. »

### 3.5 Codex SDK TypeScript (C4, C5)

- `npm install @openai/codex-sdk` ; « it requires Node.js 18 or later » (C4).
- Fonctionnement : « It spawns the CLI and exchanges JSONL events over stdin/stdout. »
  (C5) : le SDK dépend donc du binaire Codex.
- `startThread()`, `run()`, `resumeThread(threadId)` ; `runStreamed()` « returns an async
  generator of structured events » ; `outputSchema` par tour (JSON Schema ; Zod via
  `zod-to-json-schema` cible `"openAi"`) ; images `{ type: "local_image", path }` (C5).
- Persistance : threads dans `~/.codex/sessions` (C5).
- Environnement : « By default, the Codex CLI inherits the Node.js process environment. »
  ; fournir `env` remplace cet héritage, mais le SDK injecte encore des variables comme
  `CODEX_API_KEY` (C5).
- Non documentés sur les pages lues : options `sandboxMode`, `approvalPolicy`, signal
  d'annulation, option `apiKey` (C4, C5) : **Non vérifié**.

### 3.6 Codex app-server (C6)

- « the interface Codex uses to power rich clients » ; JSON-RPC 2.0 sans en-tête, sur
  stdio en JSONL ; WebSocket « experimental and unsupported ».
- `initialize` puis `initialized` ; `thread/start`, `thread/resume` (« reopen an existing
  thread by id so later turn/start calls append to it »), `thread/list`, `thread/fork`
  (`ephemeral: true` possible) ; threads stockés en JSONL sur disque.
- `turn/start` : « `outputSchema` applies only to the current turn. » ; `turn/interrupt` :
  annulation d'un tour, terminé par `status: "interrupted"`.
- Approbations : requêtes serveur `item/commandExecution/requestApproval` et
  `item/fileChange/requestApproval` (décisions accept, acceptForSession, decline, cancel),
  `item/permissions/requestApproval` ; `approvalPolicy: "never"` montré sur
  `thread/start` ; `sandboxPolicy` (`readOnly`, `workspaceWrite`, `externalSandbox`),
  « `sandboxPolicy` supports explicit read-access controls ».
- Outils Veyra typés : « `dynamicTools` on `thread/start` is an experimental field »
  (requiert `capabilities.experimentalApi = true`) ; à l'appel, « `item/tool/call` as a
  server request to the client ». MCP : `mcpServer/tool/call` ; un serveur MCP requis qui
  échoue fait échouer `thread/start`.
- Auth : `account/login/start` avec `apiKey`, `chatgpt`, `chatgptDeviceCode` ou
  `chatgptAuthTokens` (expérimental, pour hôtes gérant eux-mêmes l'auth ChatGPT) ;
  `account/read` renvoie compte et plan.
- Positionnement : pour « automating jobs or running Codex in CI », la page renvoie au SDK.

### 3.7 Réglages de confinement (C7, C8, C9, C1)

| Réglage | Effet documenté | Source |
|---|---|---|
| `sandbox_mode = "read-only"` (défaut de `codex exec`) | « The agent can inspect files, but it can't edit files or run commands without approval. » ; mais C9 : « Codex can read files and run commands within the read-only sandbox » | C3, C8, C9 |
| `approval_policy = "never"` | « No approval prompts. » ; valeurs `on-request \| never \| { granular = ... }`, « `untrusted` is unsupported » | C7, C8 |
| `features.shell_tool = false` | « Enable command execution tools (stable; on by default). » : désactivable | C7 |
| `tools.web_search = false` | Recherche web désactivable | C7 |
| `features.view_image = false` | Désactive l'outil `view_image` local | C7 |
| `mcp_servers.<id>.enabled = false` ; aucun `mcp_servers` | « Disable an MCP server without removing its configuration. » | C7 |
| `features.hooks`, `plugins._default.enabled`, `skills.include_instructions` | Hooks, plugins, instructions de skills pilotables | C7 |
| `projects.<path>.trust_level` (untrusted) | « Untrusted projects skip project-scoped `.codex/` layers, including project-local config, hooks, and rules. » | C7 |
| `model_instructions_file` | « Replacement for built-in instructions instead of `AGENTS.md`. » | C7 |
| `--ignore-user-config`, `--ignore-rules`, `--ephemeral` | Pas de config utilisateur, pas de règles, pas de rollout disque | C3 |
| Réseau | « By default, the agent runs with network access turned off. » | C9 |
| `forced_login_method = "chatgpt"` | Si les identifiants actifs ne correspondent pas, « Codex logs the user out and exits » | C1 |
| `cli_auth_credentials_store` | `file \| keyring \| auto \| ephemeral` | C1, C7 |

**Non garanti / non documenté** :
- Portée de lecture du mode read-only : non précisée (C8) ; Codex peut lire des fichiers
  hors du répertoire de travail : **Non vérifié**. Utiliser `permissions.<name>.filesystem`
  ou `sandboxPolicy` à accès lecture explicite (C6, C7) reste à valider.
- Désactivation de l'outil d'édition `apply_patch` : clé **non trouvée** dans les parties
  lues de C7. En read-only, l'écriture est refusée par le bac à sable, pas par l'absence
  d'outil.
- Désactivation pure du chargement d'`AGENTS.md` : pas de clé explicite trouvée (C7) ;
  contournement : cwd vide sans `AGENTS.md`.
- Bac à sable Linux : bubblewrap (`bwrap` sur `PATH` ou assistant embarqué exigeant les
  user namespaces non privilégiés), avertissement s'il manque (C8). Aucune garantie formelle.
- C9 : « Prompt injection can cause the agent to fetch and follow untrusted
  instructions. » ; « Devcontainers provide substantial protection, but they do not
  prevent every attack. » ; Codex fait du « best effort » dans les contraintes fixées.
- `dynamicTools` est expérimental (C6) : l'API peut changer.

### 3.8 API OpenAI (fournisseur `openai-api`)

- Structured Outputs : « ensures the model will always generate responses that adhere to
  your supplied JSON Schema » ; `text: { format: { type: "json_schema", "strict": true,
  "schema": ... } }` ; `additionalProperties: false` et tous les champs `required` dans les
  exemples ; champ `refusal` à tester ; `zodTextFormat` depuis `openai/helpers/zod` et
  `openai.responses.parse` (A1). Liste exhaustive des mots-clés JSON Schema acceptés non
  lue (A1 au-delà de 100 000 caractères) : **Non vérifié**.
- Function calling : « Setting `strict` to `true` will ensure function calls reliably
  adhere to the function schema. » ; `tool_choice`, `parallel_tool_calls: false` (A3).
- Images : `input_image` par URL, data URL base64 ou file ID ; `detail` `low`, `high`,
  `original`, `auto` ; « Up to 512 MB total payload per request » ; PNG, JPEG, WEBP, GIF
  non animé (A4).
- Annulation : `POST /v1/responses/{id}/cancel` en mode background, « Cancelling twice is
  idempotent » ; sans `store`, réponse supprimée après « roughly 10 minutes » (A2) ;
  côté SDK : « Pass an `AbortSignal` in the request's `signal` option to cancel a
  request » (A6).
- Streaming SSE (A6) ; rate limits RPM/RPD/TPM, en-têtes `x-ratelimit-*`, « the API
  returns a `429` error », `Retry-After` (A5) ; SDK : 2 réessais par défaut, délai 10 min,
  `RateLimitError` (A6).
- Usage de jetons dans la réponse (`usage`) : page de référence non ouverte : **Non
  vérifié**. Tarifs : **Non vérifiés**.

### 3.9 Licences et versions

| Élément | Logiciel | Poids / données | Redistribution | Source |
|---|---|---|---|---|
| Codex CLI, app-server, SDK (dépôt `openai/codex`) | « This repository is licensed under the Apache-2.0 License. » | Sans objet (modèles distants) | Apache-2.0 (attribution, NOTICE) ; licence propre du paquet npm `@openai/codex-sdk` non lue : **Non vérifié** | C12 |
| SDK `openai` (npm) | Apache-2.0 ; « Node.js 22 is the minimum supported version. » | Sans objet | Apache-2.0 | A6 |
| Service (modèles, plan, API) | Régi par les conditions OpenAI | — | Terms / Services Agreement **non lus (403)** | T1, T2 |

- Version Codex stable : `rust-v0.166.0`, « Latest », publiée le 29 oct. 2026 ; pré-version
  `0.168.0-alpha.1` du 4 nov. 2026 (C13). Aucun usage non commercial signalé sur les pages
  lues.

## 4. Réponses aux 9 questions

| # | Question | Réponse | Statut |
|---|---|---|---|
| 1 | Codex intégrable officiellement ? | Techniquement oui et encouragé (O2). Avec le **compte ChatGPT** dans une appli privée : aucun texte ne l'autorise explicitement ; C1 recommande la clé API pour le programmatique, C2 tolère le compte Codex pour une « trusted private automation » en workflow avancé. Avec clé API : conforme aux recommandations (C1, C2). | Clé API : **AUTORISÉ** (recommandé). Compte ChatGPT : **AMBIGU** |
| 2 | Auth ChatGPT prise en charge, par quelle interface ? | CLI : `codex login` (navigateur, `--device-auth`) (C1) ; SDK : hérite du login du CLI qu'il lance (C3, C5) ; app-server : `account/login/start` `chatgpt` / `chatgptDeviceCode` / `chatgptAuthTokens` (C6), ou `ACCESS_TOKEN` issu de Sign in with ChatGPT (O4). | Fait technique |
| 3 | Usage de l'abonnement autorisé pour ce studio personnel ? | Pas d'autorisation explicite. Mécanisme 2 : « available to all open-source partners and selected private clients » (O13) ; Veyra est privé et non publié, donc relève de « selected private clients » (sélection requise). Mécanisme 1 : C2 (« trusted private automation ») est la permission la plus proche, mais elle vise la CI/CD, pas une appli ; Terms of Use non lisibles. | **AMBIGU** (mécanisme 1) ; **non acquis** sans sélection (mécanisme 2) |
| 4 | Programme ou inscription nécessaire ? | Mécanisme 2 : oui, enregistrement OAuth dynamique avec consentement pour les applis open source (O8, O13) ; formulaire d'intérêt / liste d'attente pour les autres (O3, O10). Mécanisme 1 : aucun programme documenté. | Fait documenté |
| 5 | app-server, SDK ou CLI ? | Veyra n'a besoin que de 4 appels JSON validés par Zod, sans outils agents. `codex exec --json --output-schema --ephemeral` lancé par chemin absolu couvre ce besoin sans nouvelle dépendance npm (C3), selon le motif déjà utilisé pour ffmpeg. SDK : même binaire, ajoute `runStreamed`, images, threads (C5). app-server : seul à offrir `turn/interrupt`, approbations gérées par l'hôte, `dynamicTools`, `account/read` (C6), et seul relais documenté du mécanisme 2 (O4) ; plus complexe, en partie expérimental. | Choix technique |
| 6 | Sessions persistées et reprises ? | Oui : `codex exec resume` (C3) ; `resumeThread` + `~/.codex/sessions` (C5) ; `thread/resume`, `thread/list`, JSONL sur disque (C6). Désactivable : `--ephemeral` (C3). Veyra n'en a pas besoin. | Fait technique |
| 7 | Approbations et outils ; outils Veyra seuls ? | Oui en configuration : read-only + `approval_policy = "never"` + `features.shell_tool = false` + `tools.web_search = false` + `features.view_image = false` + aucun MCP + cwd vide hors dépôt + `--ignore-user-config` / `--ignore-rules` (C3, C7, C8, C9). Outils typés : `dynamicTools` app-server (expérimental) ou serveur MCP local ; plus simple : sortie structurée seule (`--output-schema`). Non garanti : portée de lecture, `apply_patch`, injection de prompt (§ 3.7). | Fait technique |
| 8 | Séparer abonnement et facturation API ? | Oui : deux modes d'auth distincts (C1) ; `forced_login_method = "chatgpt"` provoque logout et arrêt si les identifiants diffèrent (C1) ; mécanisme 2 : pas de bascule silencieuse côté OpenAI (O12). Facturations séparées (C1, C10). | Documenté |
| 9 | Empêcher une bascule silencieuse ? | Ordre de priorité `OPENAI_API_KEY` / `CODEX_API_KEY` vs login ChatGPT : **non documenté** (C1, C3). Mesures : environnement enfant construit explicitement sans `OPENAI_API_KEY` ni `CODEX_API_KEY`, `-c forced_login_method="chatgpt"`, et refus de démarrer si l'une des deux variables est présente. Avec le SDK, `env` remplace l'héritage mais le SDK injecte encore `CODEX_API_KEY` (C5) : à vérifier dans le code. app-server : contrôler `account/read` avant chaque tour (C6). | Mesures documentées ; priorité **Non vérifiée** |

## 5. Matrice fournisseur

| Fournisseur | Authentification | Structuré | Images | Outils | Streaming | Annulation | Reprise | Coût / usage | Conformité | Disponibilité |
|---|---|---|---|---|---|---|---|---|---|---|
| `openai-api` (Responses API, SDK `openai`) | Clé API Platform | `json_schema` strict, `responses.parse` + Zod (A1) | `input_image` (A4) | Function calling strict (A3) | SSE (A6) | `AbortSignal` (A6) ; `/cancel` en background (A2) | `previous_response_id` / état stocké (non détaillé ici) | Facturé au tarif API (C1) ; tarifs et champ `usage` **Non vérifiés** | **AUTORISÉ** (voie recommandée, C1, C2) ; Terms non lus | Immédiate avec une clé |
| `codex-chatgpt` via CLI `codex exec` | Login ChatGPT sauvegardé (C3) | `--output-schema` (C3) | `--image` (C5) | Agent Codex ; désactivables (C7) | `--json` JSONL (C3) | Arrêt du processus (non documenté comme API) | `exec resume` (C3) | Plan ChatGPT, limites 5 h pour Plus (C10, O9) ; pas de jetons/coût chiffrés lus | **AMBIGU** (C1, C2) | Binaire à installer + login par l'utilisateur |
| `codex-chatgpt` via SDK `@openai/codex-sdk` | Idem (lance le CLI, C5) | `outputSchema` (C5) | `local_image` (C5) | Idem | `runStreamed` (C5) | **Non vérifié** | `resumeThread` (C5) | Idem | **AMBIGU** | Dépendance npm + binaire |
| `codex-chatgpt` via app-server (login Codex) | `account/login/start` `chatgpt` (C6) | `outputSchema` par tour (C6) | Non détaillé sur la partie lue : **Non vérifié** | Approbations hôte, `dynamicTools` (exp.), MCP (C6) | Événements JSON-RPC (C6) | `turn/interrupt` (C6) | `thread/resume` (C6) | Idem | **AMBIGU** | Binaire ; protocole partiellement expérimental |
| app-server ou HTTP avec Sign in with ChatGPT (`ACCESS_TOKEN`) | OAuth propre à Veyra, scope `chatgpt.tokens.use.direct` (O8) | **Non vérifié** (O7 muet) | Oui si le modèle les accepte (O7) | Pas de MCP hébergé ni `tool_search` (O7) | Obligatoire (`stream: true`, O7) | `turn/interrupt` via app-server (C6) | Pas de `previous_response_id` en HTTP (O7) ; `thread/resume` (O4) | Plan ChatGPT ; pas de bascule silencieuse (O12) | **AUTORISÉ seulement si éligible** : open source ou « selected private clients » (O13) | Veyra privé : formulaire d'intérêt ; si publié open source : enregistrement dynamique |

## 6. Recommandation et repli

Condition posée : `codex-chatgpt` « uniquement si c'est officiellement autorisé ». Aucune
page lue ne l'autorise explicitement pour une application privée qui pilote Codex avec le
compte ChatGPT de son titulaire. Les Terms of Use et Usage Policies sont illisibles (403).
**La condition n'est donc pas remplie.** On ne déduit pas d'autorisation de la faisabilité,
ni du blog O2.

1. **Recommandé pour l'automatisation : `openai-api`** (clé API). C'est la voie
   recommandée par OpenAI pour le programmatique (C1, C2). Fonctionnellement, elle est
   équivalente au fournisseur `anthropic-api` existant : JSON strict, images, annulation.
2. **Voie abonnement conforme (à terme)** : Sign in with ChatGPT – ChatGPT plan usage, dans
   l'un de ces deux cas :
   (a) Veyra est publié en open source (le dépôt https://github.com/tsnaketech/veyra
   n'est pas encore publié) ; il entre alors dans le périmètre « open-source and locally
   hosted apps » (O3) avec enregistrement dynamique (O8). Le terme « open-source
   partners » (O13) laisse un doute sur l'existence d'un statut de partenaire distinct :
   **AMBIGU**.
   (b) Veyra est retenu comme « selected private client » via le formulaire (O10, O13).
   Cette voie permet d'appeler `/v1/responses` sans agent (O11), donc sans risque shell.
3. **`codex-chatgpt` (mécanisme 1)** : ne l'implémenter qu'après une décision explicite
   de l'utilisateur qui accepte le statut AMBIGU, ou après confirmation écrite d'OpenAI.
   Le cas échéant, utiliser le plan minimal du § 7.
4. **Repli** : fournisseurs actuels (`anthropic-api`, `claude-subscribe` assisté D010).

## 7. Plan d'implémentation minimal proposé (non exécuté)

Applicable tel quel au mécanisme 1 si l'utilisateur accepte l'ambiguïté. Pour le
mécanisme 2, la même interface s'applique, mais l'appel devient HTTP Responses avec le
jeton OAuth (O7, O11), sans binaire Codex.

1. Décision dans `docs/DECISIONS.md` : statut de conformité retenu, sources, date.
2. `packages/ai/src/index.ts` : ajouter `"codex-chatgpt"` à `providerIds`, élargir
   `AiProvider.kind`. Les quatre méthodes ne changent pas.
3. Implémentation : un seul module qui lance le binaire Codex par **chemin absolu**
   configuré (motif T127-sec), sans dépendance npm, avec :
   `codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules
   --sandbox read-only --output-schema <fichier.json> -c approval_policy="never"
   -c features.shell_tool=false -c tools.web_search=false -c features.view_image=false
   -c forced_login_method="chatgpt" [--image <png>]... <prompt>`.
   Exécuter dans un répertoire temporaire vide créé par appel, avec `CODEX_HOME` dédié,
   sans `mcp_servers`.
   Les noms exacts des surcharges `-c` sont tirés de C7 ; leur effet n'a pas été testé.
4. Schéma : `z.toJSONSchema` (déjà utilisé côté Anthropic) écrit dans le répertoire
   temporaire. La sortie finale est **toujours** revalidée avec les schémas Zod existants
   (`storyboardDraftSchema`, `reviewSchema`, etc.) ; tout écart produit une erreur typée,
   sans repli silencieux.
5. Environnement enfant construit en liste blanche (`PATH`, `HOME`/`CODEX_HOME`). Refus
   de démarrer si `OPENAI_API_KEY` ou `CODEX_API_KEY` est présent. Ne jamais journaliser
   `auth.json` (C2 : « Treat ~/.codex/auth.json like a password »).
6. Annulation : tuer le processus enfant sur `AbortSignal`, avec un délai maximal ; traiter
   l'événement `error` et les codes de sortie non nuls.
7. Tests : exécutable factice qui émet du JSONL enregistré, avec
   `VEYRA_AI_PROVIDER=fake` par défaut. Aucun test réel sans login de l'utilisateur.
8. `ARCHITECTURE.md` : Codex CLI Apache-2.0 (C12), version figée (`rust-v0.166.0`,
   C13). `RUNBOOK.md` : installation et login par l'utilisateur.

## 8. Actions qui exigent l'utilisateur

- Décider s'il accepte le statut **AMBIGU** du mécanisme 1, ou s'il demande une
  confirmation à OpenAI. Une telle demande est une transmission à un tiers et relève de
  l'utilisateur.
- Installer lui-même le binaire Codex (C12), puis exécuter `codex login` avec son propre
  compte ChatGPT (C1). Aucun agent ne doit le faire.
- Pour le mécanisme 2 : soit publier Veyra en open source (décision de publication, hors
  périmètre), soit remplir le formulaire d'intérêt (O3, O10). Puis consentir dans le
  navigateur au scope `chatgpt.tokens.use.direct` (O8).
- Pour `openai-api` : créer une clé API Platform et l'enregistrer par nom (D009), ce qui
  implique une facturation à l'usage (C1).
- Relire les Terms of Use et Usage Policies (inaccessibles à l'outil) avant toute décision.

## 9. Risques

- **Conditions non lues** (T1, T2, O5, T3 en 403) : une clause générale sur l'accès
  automatisé peut exister. **Non vérifié.**
- Codex est un agent (shell, édition de fichiers, réseau sur demande). Même confiné, le
  mode read-only peut lire des fichiers et lancer des commandes en lecture seule (C9) ;
  la portée de lecture n'est pas documentée (C8). Le risque d'injection de prompt via
  les entrées utilisateur et les images est reconnu (C9).
- Bascule silencieuse vers la facturation API : ordre de priorité non documenté (C1,
  C3) ; le SDK injecte `CODEX_API_KEY` (C5).
- Instabilité : `dynamicTools`, `chatgptAuthTokens` et WebSocket sont expérimentaux (C6) ;
  pré-versions fréquentes (C13) ; docs déplacées vers learn.chatgpt.com (308) ; O16 en 404.
- Limites du plan partagées avec l'usage personnel de ChatGPT et de Codex (O9, C10, C11) ;
  une génération Veyra peut épuiser la fenêtre de 5 h (Plus).
- Lecture partielle de C6, C7 et A1 : des options pertinentes peuvent exister dans les
  parties non lues.
