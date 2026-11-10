# Recherche : fournisseur IA local (partie L) et usage de Veyra depuis ChatGPT (partie O3)

Statut : recherche documentaire uniquement. Rien n'a été installé, téléchargé ni exécuté.
Date de consultation de toutes les sources : 2026-11-04.
Auteur : Research Analyst (sous-agent). Ce document n'est pas une décision ; une décision
éventuelle relève de [DECISIONS](../DECISIONS.md).

Conventions :

- **[Sn]** renvoie au tableau des sources (section 7), qui donne l'URL, un court extrait et
  la date de consultation.
- **Documenté** : affirmé par une page ouverte. **Secondaire** : page tierce non officielle.
  **Estimation** : calcul ou extrapolation de l'auteur, sans mesure sur la machine cible.
  **Non vérifié** : aucune page ouverte ne le confirme.
- Les extraits sont ceux que l'outil de lecture a restitués (pages converties puis
  résumées). Il faut les revérifier mot pour mot avant de les citer dans une décision.
- Aucune mesure n'a été faite sur la machine cible (4 vCPU, 16 Go de RAM, sans GPU).

Contexte Veyra : l'interface `AiProvider` (`packages/ai/src/index.ts`, l. 121-139)
expose `generateStoryboard`, `planRevision`, `reviewFrames` et `qualityEvaluator`, et
n'accepte aujourd'hui que `kind: "fake" | "anthropic-api"`. Un fournisseur local
demanderait un nouveau `kind`. Ce changement n'est pas fait ici ; c'est seulement une
proposition.

---

## 1. Partie L — serveurs d'inférence locaux

### 1.1 Tableau comparatif

| Critère | Ollama | llama.cpp `llama-server` | LocalAI (autre serveur) |
|---|---|---|---|
| Version observée | v0.40.14 « Latest », publiée le 03 Nov ; v0.40.15-rc0 en pré-version [S1] | b12110 (pré-version, « Nightly build », 04 Nov) ; une version « Latest » étiquetée v0.9.0 [S8] | 4.11.0 (actualité d'octobre 2026, non confirmée par l'onglet Releases) [S13] |
| Licence du logiciel | MIT [S4] | MIT, « Copyright (c) 2023-2026 The ggml authors » [S9] | MIT [S13] |
| API compatible OpenAI | Oui : `/v1/chat/completions` et `/v1/responses` sans état [S3] | Oui : routes de chat completions, de responses et d'embeddings [S6] ; `/v1/responses` est converti en chat completions [S7] | Revendiquée : « Drop-in API compatibility » [S13] |
| API native | `/api/chat`, port 11434 [S16] | `/completion`, `/v1/messages` (Anthropic) [S6][S7] | — |
| Sorties structurées | `format` accepte `"json"` ou un JSON Schema [S2][S16] ; `response_format` par l'API OpenAI [S2] ; exemple Zod `z.toJSONSchema()` [S2] | `json_schema` et `grammar` (GBNF) [S6] ; `response_format` de type `json_schema` [S7] ; ne gère qu'un **sous-ensemble** de JSON Schema, les mots-clés non pris en charge sont ignorés sans avertissement [S11] | `grammar` en BNF, uniquement avec le backend llama.cpp ; aucune mention de JSON Schema [S12] |
| Appels d'outils | `tools` sur `/api/chat` [S16] et sur chat completions [S3] | « Function calling / tool use for ~any model » [S6] ; formats natifs pour plusieurs familles et repli « Generic » [S10] | « OpenAI-compatible tools API » [S13] |
| Entrée image | `images` en base64 par message [S16] ; l'API OpenAI accepte le base64, pas les URL d'image [S3] | `--mmproj`, fonction indiquée comme « experimental » [S6] ; `image_url` limité aux data URL [S7] | « Vision API » [S13] |
| Annulation | **Non vérifié** : la documentation ouverte n'en parle pas [S16]. Des sources tierces signalent une annulation partielle côté client [S17] | **Non vérifié** : le README ne contient ni « cancel » ni « disconnect » [S7]. Des projets tiers ont dû ajouter un arrêt de la génération après une déconnexion [S18] | Problème signalé (issue #974) : le serveur continue de générer après l'abandon du client [S17] |
| Écoute par défaut et sécurité | `localhost:11434` [S16] | `--host` par défaut 127.0.0.1 ; `--api-key` ou `--api-key-file` [S6]. Port par défaut indiqué : 9931 [S6][S7] (**à revérifier** à l'installation) | Non vérifié |
| Gestion des modèles | Bibliothèque de modèles intégrée (`ollama.com/library`) [S19] | Fichiers GGUF fournis manuellement (`-m`) | Galerie de modèles (non vérifiée en détail) |
| Sans GPU | Non vérifié dans les pages lues | Oui (backend CPU ; voir [S11] et les mesures CPU tierces [S22]) | « No GPU required », mode « CPU-only » [S13] |

### 1.2 Points importants pour Veyra

- **La validation Zod reste obligatoire dans les trois cas.** Le décodage contraint garantit
  au mieux la forme JSON, pas les règles métier (durées, identifiants de composants,
  `checkTiming`). Côté llama.cpp, un mot-clé de schéma non pris en charge est **ignoré sans
  avertissement** [S11]. Le schéma réellement appliqué peut donc être plus lâche que le
  schéma Zod.
- **llama.cpp ne transmet pas le schéma au modèle** : « The JSON schema is only used to
  constrain the model output and is not injected into the prompt » [S11]. Ollama recommande
  aussi de mettre le schéma dans le prompt [S2]. Le prompt doit donc décrire la structure
  attendue dans les deux cas.
- **Limites de schéma dans llama.cpp** [S11] : `$ref` imbriqués cassés, `prefixItems` cassé,
  `properties` impossible à combiner avec `anyOf`/`oneOf` dans un même type, `minimum` et
  `maximum` limités aux entiers, pas de `patternProperties`. Il faudra vérifier les schémas
  émis par `z.toJSONSchema()` à partir de `storyboardDraftSchema` (Estimation : les unions
  de composants risquent de buter sur la limite `anyOf` + `properties`).
- **Qualité des appels d'outils** : une quantification agressive du cache KV (par exemple
  `-ctk q4_0`) « can substantially degrade the model's tool calling performance » [S10].
- **Mode « thinking »** : Qwen3 et Qwen3.5 réfléchissent par défaut [S20][S21]. Sur CPU,
  ces jetons supplémentaires multiplient la durée d'un storyboard. Il faut désactiver ce
  mode (`think: false` chez Ollama [S16] ; `enable_thinking: False` pour Qwen3.5, qui ne
  prend pas en charge `/no_think` [S21]).
- **Annulation** : aucun des trois serveurs ne documente clairement l'arrêt de la génération
  quand le client se déconnecte (Non vérifié). Un POC doit le tester. Sur une machine à
  4 vCPU, une génération orpheline bloque toute la machine.

---

## 2. Partie L — modèles candidats (CPU, 16 Go)

Les tailles proviennent des pages de la bibliothèque Ollama (quantification par défaut de
chaque tag, généralement Q4 ; la quantification exacte de chaque tag n'a pas été vérifiée).
Les licences des poids proviennent des fiches Hugging Face quand elles ont été ouvertes.
La page Ollama ne mentionne pas la licence pour Qwen [S19][S23].

### 2.1 Tableau

| Modèle | Fichier (Ollama) | RAM estimée * | Vitesse CPU attendue ** | Outils et JSON | Vision | Licence des poids |
|---|---|---|---|---|---|---|
| **Qwen3.5-4B** | 3,3–4,0 Go [S23] | 5–6 Go | Estimation : 6–15 tok/s | Outils et thinking indiqués [S23] ; famille « excels in tool calling » [S21] | Oui, texte et image [S23] | Apache-2.0 (fiche 9B [S21] ; **fiche 4B non ouverte**) |
| **Qwen3.5-9B** | 6,6–7,6 Go [S23] | 8–10 Go | Estimation : 3–8 tok/s | Idem [S21] | Oui [S21][S23] | Apache-2.0 [S21] |
| **Qwen3-8B** (texte seul) | 5,2 Go [S19] | 7–8 Go | Estimation : 3–8 tok/s (secondaire : 6–10 tok/s pour un 8B Q4_K_M sur un CPU de bureau à 8 cœurs [S22]) | « Qwen3 excels in tool calling » [S20] ; Qwen 2.5 a un format natif dans llama.cpp, Qwen3 n'est pas cité nommément [S10] | Non | Apache-2.0 [S20] |
| **Qwen3-VL-4B** | 3,3 Go [S24] | 5–6 Go | Estimation : 6–15 tok/s (texte) | Outils, agent visuel [S24][S25] | Oui [S24] | Apache-2.0 [S25] |
| **Gemma 4 E4B** | 6,6–9,5 Go selon la variante [S26] | 8–11 Go | Estimation : 4–10 tok/s (≈ 4,5 B paramètres effectifs, ≈ 8 B avec les embeddings [S27]) | « Native support for structured tool use » [S27] | Oui (image et audio) [S27] | Apache 2.0 [S27][S28] |
| **Granite 4 (3b)** | 2,1 Go [S29] | 3–4 Go | Estimation : 10–25 tok/s | Outils, « improved … tool-calling » [S29] ; sorties structurées non mentionnées | Non | Apache 2.0 [S29] |
| **gpt-oss-20b** | 14 Go [S30] | ≥ 16 Go | Estimation : non pertinent (voir ci-dessous) | Function calling et Structured Outputs [S31] ; format harmony obligatoire [S31] | Non | Apache 2.0 [S30][S31] |
| Gemma 3 (4b, 12b) | 3,4 / 8,2 Go [S32] | — | — | Outils non indiqués [S32] | Oui [S32] | **Restrictive** : Gemma Terms of Use [S33] |

\* RAM = fichier + cache de contexte (≈ 1–2 Go pour 8 k jetons) + surcoût du runtime.
**Estimation** non mesurée.

\** Vitesse de génération sur 4 vCPU. **Estimation** : l'inférence CPU est limitée par la
bande passante mémoire, donc le débit varie à peu près à l'inverse de la taille du fichier.
Ces fourchettes sont extrapolées depuis une source **secondaire** non mesurée par son auteur
pour la plupart des chiffres [S22] (Ryzen 7 5800X, DDR4 double canal : Llama 3.2 3B Q4_K_M
« 25–30 », Llama 3.1 8B Q4_K_M « 6–10 », et 6,8–8,4 tok/s **à 4 threads**). Elles sont
abaissées pour tenir compte d'un vCPU de VM Proxmox, dont la bande passante est inconnue.
Aucun chiffre ne vient d'une mesure sur la machine cible.

### 2.2 Exclusions et signalements

- **gpt-oss-20b : à exclure de cette machine.** Ollama indique « as little as 16GB memory »
  [S30]. Or le fichier fait 14 Go [S30], et le Studio, Chrome headless (rendu) et ffmpeg
  doivent tourner en même temps. Le risque de swap ou d'arrêt par manque de mémoire (OOM)
  est élevé (Estimation).
- **Modèles de 26 à 35 B** (Qwen3.8-27B à 18 Go [S34], Gemma 4 26b/31b à 16–20 Go [S26],
  Qwen3-30B à 19 Go [S19]) : exclus, car ils ne tiennent pas en 16 Go.
- **Gemma 3 : licence restrictive.** Ce n'est pas une licence « non commerciale », mais elle
  impose une Prohibited Use Policy à faire suivre aux destinataires, et Google « reserves
  the right to restrict (remotely or otherwise) usage » [S33]. Préférer Gemma 4, publié sous
  Apache 2.0 [S27][S28].
- **Modèles récents non évalués** (lfm3, bonsai-2, nimble, mimo-v2.6, nemotron-3.5…),
  visibles dans la bibliothèque Ollama [S35] : licences et qualité **non vérifiées**. Ne pas
  les retenir sans lire leur fiche de licence (certaines licences « open » de fournisseurs
  imposent des seuils commerciaux ; Non vérifié pour ces modèles).
- **Fiabilité des sorties structurées et des appels d'outils** : aucune source ouverte ne
  fournit de mesure comparable pour ces modèles sur ce type de tâche. **Non vérifié** ; c'est
  l'objet du POC.
- **Support de Qwen3.5 par llama.cpp** (architecture hybride Gated DeltaNet + MoE [S21]) :
  **Non vérifié**. Le support par Ollama est attesté par sa page de bibliothèque [S23].
- **Licences à séparer** :
  - Logiciel serveur : MIT.
  - Poids : Apache 2.0 pour les candidats retenus.
  - GGUF re-quantifiés par des tiers : ils héritent de la licence des poids, à vérifier sur
    chaque dépôt.
  - Données d'entraînement : non concernées, car Veyra n'entraîne rien.
  - Attribution et redistribution : Apache 2.0 impose de conserver LICENSE/NOTICE si Veyra
    redistribuait un jour les poids. Ce n'est pas prévu : l'utilisateur les télécharge
    lui-même.
  - Aucun candidat retenu n'est sous licence non commerciale.

---

## 3. Conclusion pour la partie L

### 3.1 Ce qui est réaliste sur cette machine (Estimation)

- **Faisable :** des modèles de 3 à 9 B quantifiés en Q4, un seul chargé à la fois, avec le
  thinking désactivé et un contexte d'environ 8 k jetons.
- **Temps estimé d'un storyboard** (1 000 à 2 000 jetons en sortie, prompt et schéma
  d'environ 2 000 à 4 000 jetons) :

  | Taille du modèle | Débit de génération | Génération seule | Total avec le traitement du prompt |
  |---|---|---|---|
  | ~4 B | 6–15 tok/s | ≈ 1,1 à 5,5 min | ≈ 2 à 7 min |
  | ~8–9 B | 3–8 tok/s | ≈ 2 à 11 min | ≈ 3 à 13 min |

  Ces chiffres sont des estimations, sans aucune mesure. Le thinking activé ajouterait
  plusieurs milliers de jetons, soit plusieurs fois la durée.
- **Limites :**
  - Le modèle ne peut pas tourner en même temps qu'un rendu Chrome et ffmpeg sans
    contention CPU.
  - L'analyse d'images (`reviewFrames`) sur CPU est probablement lente : l'encodeur visuel
    s'exécute pour chaque image (Non vérifié).
  - La qualité créative est très inférieure à celle du fournisseur `anthropic-api`
    (Estimation, non mesurée).
  - L'annulation n'est pas garantie (section 1.2).

### 3.2 Recommandation et repli

- **Recommandation (POC) :** Ollama avec **Qwen3.5-4B**, puis Qwen3.5-9B si la qualité est
  insuffisante et que le temps reste acceptable. Raisons :
  - `format` accepte directement un JSON Schema issu de Zod [S2] ;
  - outils et images sont exposés sur la même API [S16] ;
  - Qwen3.5 est disponible dans la bibliothèque [S23] ;
  - le logiciel et les poids sont sous licences permissives [S4][S21].
- **Repli :** `llama-server` avec **Qwen3-8B** ou **Gemma 4 E4B** en GGUF, pour un contrôle
  fin (GBNF, `--api-key`, écoute 127.0.0.1 par défaut [S6]), en tenant compte des limites
  JSON Schema [S11]. Repli léger : **Granite 4 3b** [S29] si la machine est trop lente.
- **Intégration proposée (non faite) :**
  - nouveau `kind` dans `AiProvider` (par exemple `"local-openai"`) qui appelle
    `127.0.0.1` ;
  - schéma Zod → JSON Schema pour le décodage contraint ;
  - validation Zod complète, avec au plus une nouvelle tentative en cas d'échec ;
  - affichage explicite « modèle local » dans le Studio.

### 3.3 Plan de POC proposé (non exécuté)

| Étape | Action | Autorisation de l'utilisateur requise |
|---|---|---|
| 1 | Choisir le binaire et la version (Ollama v0.40.14 [S1] ou llama.cpp [S8]) | Non (lecture) |
| 2 | Installer le serveur, en écoute sur 127.0.0.1 uniquement | **Oui** : installation logicielle et accès réseau |
| 3 | Télécharger Qwen3.5-4B (≈ 3,3–4,0 Go [S23]), puis éventuellement Qwen3.5-9B (≈ 6,6–7,6 Go) | **Oui** : téléchargement de poids et accès réseau |
| 4 | Mesurer la vitesse de génération et de traitement du prompt sur la machine (par exemple `llama-bench`, ou les durées renvoyées par l'API ; noms des champs à vérifier dans la doc) | **Oui** : exécution |
| 5 | Exporter `storyboardDraftSchema` en JSON Schema et vérifier les mots-clés ignorés [S11] | Non (code local, hors pipeline) |
| 6 | Banc de 20 prompts : taux de JSON valide en Zod, taux de `checkTiming` respecté, durée totale, RAM maximale | **Oui** : exécution |
| 7 | Tester les appels d'outils sur 3 outils de `TOOL-REGISTRY.md` en lecture seule | **Oui** : exécution |
| 8 | Tester l'annulation : fermer le client en cours de génération et observer le CPU | **Oui** : exécution |
| 9 | Consigner les résultats dans `TASKS.md` et proposer une décision dans `DECISIONS.md` | Validation par l'utilisateur |

Critères de réussite à fixer avec l'utilisateur. Proposition :

- au moins 90 % de storyboards valides en Zod sans nouvelle tentative ;
- moins de 5 minutes par storyboard ;
- RAM maximale inférieure à 10 Go.

---

## 4. Partie O3 — utiliser Veyra depuis ChatGPT (étude seulement)

### 4.1 Exigences documentées

| Sujet | Ce que disent les sources |
|---|---|
| Connectivité | Le serveur MCP doit être « reachable through a public HTTPS endpoint or Secure MCP Tunnel » [S36]. Un serveur sur 127.0.0.1 n'est donc pas joignable tel quel. Pour les tests locaux, la doc évoque « A development tunnel or another HTTPS forwarding service » [S36][S38]. Les tunnels temporaires et les points d'accès locaux ne conviennent pas à une soumission publique [S37]. |
| Secure MCP Tunnel | `openai/tunnel-client` (Apache 2.0) tourne à côté du serveur MCP local et fait uniquement des appels HTTPS **sortants** vers OpenAI (long-polling de `/v1/tunnels/{tunnel_id}/poll`). Il exige un `CONTROL_PLANE_API_KEY` et un `CONTROL_PLANE_TUNNEL_ID` [S39]. Lancement fin mai 2026 (secondaire [S40]). |
| Transport | « streamable HTTP, typically at `/mcp` » [S36][S37]. SSE n'est pas mentionné dans les pages ouvertes (Non vérifié). |
| Authentification | Elle n'est pas toujours obligatoire : « anything that exposes customer-specific data or write actions should authenticate users ». Le mode `noauth` est possible par outil. Sinon : OAuth 2.1 conforme à la spécification d'autorisation MCP, PKCE `S256`, CIMD (préféré) ou DCR. Les identifiants client (client credentials) et les clés d'API personnalisées ne sont pas pris en charge [S41]. |
| Annotations d'outils | `readOnlyHint` (« true only when the tool cannot change state ») et `destructiveHint` (« irreversible or difficult to reverse ») [S37]. |
| Plans ChatGPT | **Non vérifié directement** : la page officielle du developer mode renvoie une erreur 404 et l'article d'aide une erreur 403 (section 6). Selon les extraits du moteur de recherche [S42] : le developer mode serait ouvert à « Pro, Plus, Business, Enterprise, and Education accounts on the web », mais l'article d'aide indiquerait que le support MCP complet (écriture) est en bêta pour « Business, Enterprise, and Edu », avec activation par un administrateur. Les sources se contredisent. |

### 4.2 Ce qu'il faudrait (description seulement ; aucune recommandation de tunnel ni d'exposition)

1. Un serveur MCP distinct du Studio, en HTTP streamable sur `/mcp`, qui exposerait
   seulement un sous-ensemble d'outils typés du registre :
   - lecture seule d'abord ;
   - toute action d'écriture annotée `destructiveHint` et soumise à confirmation.
2. Un chemin d'accès depuis OpenAI, avec deux variantes possibles :
   - un tunnel sortant (Secure MCP Tunnel), qui implique une clé de l'API OpenAI Platform et
     transmet à OpenAI les requêtes et réponses MCP ;
   - un proxy HTTPS public.

   Les deux variantes sont une **transmission de données à un tiers**. Elles demandent une
   autorisation explicite selon AGENTS.md et une mise à jour de [SECURITY](../SECURITY.md).
3. OAuth 2.1 avec PKCE S256 si des données de projet ou des actions d'écriture sont exposées
   [S41]. Cela ajoute un serveur d'autorisation à exploiter, ce qui contredit en partie le
   caractère « personnel, local-first, non-SaaS ».
4. Un plan ChatGPT compatible (à confirmer sur le compte de l'utilisateur, voir 4.1).

### 4.3 Risques

- **Exposition du Studio :** le Studio actuel n'a pas été conçu pour être joignable de
  l'extérieur (127.0.0.1). Un tunnel ou un proxy rend accessibles depuis Internet ou depuis
  OpenAI ses fichiers, ses médias et ses commandes de rendu. Les points d'administration du
  tunnel-client (`/healthz`, `/metrics`, `/ui`) doivent aussi rester locaux [S39].
- **Injection de prompt :** OpenAI demande de « Assume prompt injection and malicious inputs
  will reach your server » et de valider toutes les entrées côté serveur [S43]. Les retours
  vidéo, les transcriptions et les métadonnées de fichiers sont des vecteurs possibles.
- **Actions destructives :** utiliser les confirmations de l'hôte et exiger une confirmation
  humaine pour les opérations irréversibles [S43]. Ne pas exposer de suppression ni de rendu
  lourd sans garde-fou.
- **Fuite de secrets :** ne mettre aucun jeton dans les props des composants [S43]. Ne jamais
  transmettre `ANTHROPIC_API_KEY` ni la clé du tunnel. Garder la clé du tunnel en `0600` et
  ne pas utiliser la clé d'administration pour le démon [S39].
- **Moindre privilège :** demander seulement les scopes nécessaires [S43].

**Conclusion O3 :** techniquement possible, mais cela exige soit une exposition, soit un
tunnel tiers, une authentification OAuth pour toute écriture, et un serveur MCP dédié.
Cela va à l'encontre du modèle local-first actuel. À ne pas engager sans décision explicite
de l'utilisateur.

---

## 5. Risques transverses

| Risque | Gravité | Atténuation proposée |
|---|---|---|
| Lenteur sur CPU qui rend le flux conversationnel inutilisable | Élevée | POC mesuré avant toute intégration ; thinking désactivé ; modèle de 4 B |
| Schéma contraint plus lâche que Zod (mots-clés ignorés) | Moyenne | Validation Zod systématique ; schéma simplifié pour la génération |
| Génération orpheline après annulation | Moyenne | Test dédié ; un seul slot ; arrêt du processus en dernier recours |
| Contention de RAM avec le rendu | Moyenne | Ne pas générer pendant un rendu ; `keep_alive` court [S16] |
| Licences de modèles mal identifiées | Faible à moyenne | Lire la fiche de licence de chaque GGUF ; écarter Gemma 3 [S33] |
| Exposition du Studio par O3 | Élevée | Hors périmètre sans décision ; serveur MCP séparé en lecture seule |

## 6. Pages inaccessibles ou incomplètes

- `https://developers.openai.com/api/docs/guides/developer-mode` (et `.md`) : **404**.
- `https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt` :
  **403**.
- `https://openbenchmarking.org/test/pts/llama-cpp` : **403**.
- `https://localai.io/features/constrained_grammars/` : page déplacée ; la nouvelle adresse
  [S12] a été lue.
- README de `llama-server` : la première lecture a été tronquée ; la suite a été lue avec un
  décalage [S7].
- Les pages Ollama ne listent qu'une partie des tags (par exemple 14 sur 72 pour qwen3.5).
  Les quantifications exactes n'ont pas été vérifiées.

## 7. Sources (consultées le 2026-11-04)

| Id | URL | Extrait | Nature |
|---|---|---|---|
| S1 | https://github.com/ollama/ollama/releases | « v0.40.14 » marquée Latest, « released this 03 Nov 01:40 » | Documenté |
| S2 | https://docs.ollama.com/capabilities/structured-outputs | « Provide a JSON schema to the `format` field » ; « Structured outputs work through the OpenAI-compatible API via `response_format` » | Documenté |
| S3 | https://docs.ollama.com/api/openai-compatibility | « Only the non-stateful flavor is supported » ; images « Base64 encoded image », sans URL d'image | Documenté |
| S4 | https://github.com/ollama/ollama/blob/main/LICENSE | « MIT License … Copyright (c) Ollama » | Documenté |
| S6 | https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md | « Schema-constrained JSON response format » ; « Function calling / tool use for ~any model » ; `--host` « (default: 127.0.0.1) » ; multimodal « experimental » | Documenté |
| S7 | https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md | « port to listen (default: 9931) » ; `/v1/responses` « works by converting Responses request into Chat Completions request » ; aucune occurrence de « cancel » ou « disconnect » | Documenté |
| S8 | https://github.com/ggml-org/llama.cpp/releases | « b12110 … released this 04 Nov 12:52 » (pré-version) ; v0.9.0 « Latest » | Documenté |
| S9 | https://github.com/ggml-org/llama.cpp/blob/master/LICENSE | « MIT License … Copyright (c) 2023-2026 The ggml authors » | Documenté |
| S10 | https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md | « Function calling is supported for all models » ; repli « Generic » ; `-ctk q4_0` « can substantially degrade the model's tool calling performance » | Documenté |
| S11 | https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md | « The JSON schema is only used to constrain the model output and is not injected into the prompt » ; mots-clés non pris en charge « skipped silently » | Documenté |
| S12 | https://localai.io/docs/features/constrained_grammars/ | « This feature is only supported by models that use the llama.cpp backend » | Documenté |
| S13 | https://github.com/mudler/LocalAI | « MIT - Author Ettore Di Giacinto » ; « No GPU required » ; « Drop-in API compatibility » ; actualité « LocalAI 4.11.0 » | Documenté |
| S16 | https://docs.ollama.com/api/chat | `format` : « Can be `json` or a JSON schema » ; `tools` ; `images` « inline images for multimodal models » ; `keep_alive` ; `http://localhost:11434` | Documenté |
| S17 | https://github.com/ollama/ollama-js/issues/39 ; https://github.com/mudler/LocalAI/issues/974 | Abandon côté client : le serveur continue de générer (résumés de résultats de recherche ; issues non ouvertes) | Secondaire |
| S18 | https://github.com/mudler/LocalAI/pull/11860 | « the llama.cpp slot stayed busy until the generation ended on its own terms » (extrait de recherche) | Secondaire |
| S19 | https://ollama.com/library/qwen3 | « qwen3:8b … 5.2GB … 40K » ; « qwen3:30b … 19GB » | Documenté |
| S20 | https://huggingface.co/Qwen/Qwen3-8B | Licence « apache-2.0 » ; « Qwen3 excels in tool calling capabilities » ; `enable_thinking` | Documenté |
| S21 | https://huggingface.co/Qwen/Qwen3.5-9B | Licence « apache-2.0 » ; vision ; « does not officially support the soft switch … /think and /nothink » ; février 2026 | Documenté |
| S22 | https://specpicks.com/blog/local-llm-cpu-only-ryzen-7-5800x-2026 | 5800X CPU seul : « Llama 3.1 8B q4_K_M 6–10 », « Llama 3.2 3B 25–30 » ; à 4 threads 6,8–8,4 tok/s ; « illustrative of community measurements » | Secondaire, non mesuré par l'auteur pour l'essentiel |
| S23 | https://ollama.com/library/qwen3.5 | « 4b 3.3–4.0 GB 256K Text, Image » ; « 9b 6.6–7.6 GB » | Documenté |
| S24 | https://ollama.com/library/qwen3-vl | « qwen3-vl:4b 3.3GB 256K Text, Image » | Documenté |
| S25 | https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct | « License: apache-2.0 » ; agent visuel « invokes tools » | Documenté |
| S26 | https://ollama.com/library/gemma4 | « gemma4:e4b 6.6–9.5 GB 128K Text + image » ; 26b 16–19 Go | Documenté |
| S27 | https://huggingface.co/google/gemma-4-E4B-it | « License: Apache 2.0 » ; ≈ 4,5 B paramètres effectifs ; « Native support for structured tool use » | Documenté |
| S28 | https://opensource.googleblog.com/2026/03/gemma-4-expanding-the-gemmaverse-with-apache-20.html | « The industry-standard Apache license broadens the horizon for Gemma 4 » (2 avril 2026) | Documenté |
| S29 | https://ollama.com/library/granite4 | « granite4:3b 2.1GB 128K » ; « Apache 2.0 » ; « improved … tool-calling capabilities » | Documenté |
| S30 | https://ollama.com/library/gpt-oss | « gpt-oss:20b 14GB » ; « as little as 16GB memory » ; Apache 2.0 | Documenté |
| S31 | https://huggingface.co/openai/gpt-oss-20b | « 21B parameters with 3.6B active parameters » ; « should only be used with the harmony format » | Documenté |
| S32 | https://ollama.com/library/gemma3 | « gemma3:4b 3.4GB 128K Text + image » ; outils non mentionnés | Documenté |
| S33 | https://ai.google.dev/gemma/terms | « Google reserves the right to restrict (remotely or otherwise) usage » ; Prohibited Use Policy ; modifiée le 1er avril 2026 | Documenté |
| S34 | https://ollama.com/library/qwen3.8 | « qwen3.8:27b 18GB 256K » | Documenté |
| S35 | https://ollama.com/search?c=tools&o=newest | Liste de modèles récents (lfm3, bonsai-2, nimble…) | Documenté (liste seulement) |
| S36 | https://developers.openai.com/apps-sdk/deploy/connect-chatgpt | « reachable through a public HTTPS endpoint or Secure MCP Tunnel » ; « streamable HTTP, typically at `/mcp` » | Documenté |
| S37 | https://developers.openai.com/apps-sdk/build/mcp-server | « Expose a streamable HTTP endpoint » ; `readOnlyHint` et `destructiveHint` ; tunnels temporaires et points d'accès locaux non admis en soumission publique | Documenté |
| S38 | https://developers.openai.com/apps-sdk/deploy/testing | « A development tunnel or another HTTPS forwarding service can also provide an endpoint for local testing » | Documenté |
| S39 | https://github.com/openai/tunnel-client | « Customer-run client for Secure MCP Tunnel » ; Apache 2.0 ; `CONTROL_PLANE_API_KEY` ; garder `/ui` et `/metrics` en local | Documenté |
| S40 | https://gihyo.jp/article/2026/05/openai-secure-mcp-tunnel | Lancement fin mai 2026 (extrait de recherche) | Secondaire |
| S41 | https://developers.openai.com/apps-sdk/build/auth | « anything that exposes customer-specific data or write actions should authenticate users » ; PKCE « `S256` » ; CIMD préféré | Documenté |
| S42 | https://developers.openai.com/api/docs/guides/developer-mode (404) ; https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt (403) | Extraits du moteur de recherche seulement : « Pro, Plus, Business, Enterprise, and Education accounts on the web » ; « rolling out in beta to ChatGPT Business, Enterprise, and Edu plans » | Non vérifié (pages inaccessibles) |
| S43 | https://developers.openai.com/apps-sdk/guides/security-privacy | « Assume prompt injection and malicious inputs will reach your server » ; « Use the host's confirmation prompts for destructive actions » | Documenté |
