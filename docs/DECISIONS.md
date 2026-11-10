# Décisions

Décisions acceptées le 2026-10-27 dans le périmètre demandé.

## D001 — Monorepo pnpm

Un workspace racine, un lockfile et pnpm 12.6.0. Les contrats TypeScript sont
consommés directement via `workspace:*`. La structure SvelteKit existante est conservée.

## D002 — HyperFrames via CLI

Intégration future par `spawn` sans shell. Selon la vérification fournie dans le
cadrage utilisateur sur v0.8.209, `hyperframes/api` n’exporte que `transcribe` et
`removeBackground`. Cette vérification n’a pas été refaite pendant la phase 1 ;
HyperFrames n’est pas installé. Le contrat CLI devra être testé en phase 3.

## D003 — Animations locales et isolation

GSAP sera distribué localement, sous réserve de vérification de sa licence.
Les rendus devront fonctionner sous bwrap avec réseau désactivé. Ni la copie GSAP
ni l’isolation du moteur ne sont implémentées en phase 1.

## D004 — Interface IA et doubles explicites

L’IA sera derrière une interface ; l’adaptateur fake sera exclusivement destiné
aux tests et affiché comme tel. Les identifiants de modèles du cadrage sont
configurés sans prétendre à leur disponibilité. Le chemin réel Claude Agent SDK
reste non vérifié ; aucune clé ANTHROPIC_API_KEY n’est fournie pour sa validation.
Les tests utilisent uniquement une valeur factice injectée. Précisée par D007.

## D005 — Documentation et mémoire par domaine

`docs/system/PROJECT-SCHEMA.md` est la référence des entités, contraintes et états.
Les documents vidéo et IA seront complétés dans leurs phases respectives.
`memory/MEMORY.md` est un index vers contexte, progression, leçons et sessions ;
les exigences, décisions et détails des tâches restent dans leurs sources dédiées.

## D006 — File de rendu en processus pour le MVP

Acceptée le 2026-10-27 pour l’itération 2. Le Studio possède une file séquentielle
et un singleton serveur ; le job et sa progression sont persistés dans SQLite.
Cette solution permet de valider composition, rendu et QA avant l’orchestration IA,
sans créer un apps/worker vide ni ajouter une infrastructure de messages.

Extraire apps/worker avant déploiement multi-instance, besoin de reprise autonome
après crash, annulation distribuée ou montée en charge. Il faudra alors une prise
de job atomique avec bail, une réconciliation des running abandonnés et un protocole
de progression. Aujourd’hui resumeQueued() est explicite ; aucune reprise des
running ni garantie de concurrence entre plusieurs processus n’est revendiquée.

D002 et D003 sont implémentées dans hyperframes-adapter : CLI sans shell, GSAP
local et bwrap sans réseau. Rendu réel sous bwrap validé le 2026-10-28
(test lent et parcours E2E).

## D007 — API Messages plutôt que Claude Agent SDK pour l'IA applicative

- Date : 2026-10-28
- Statut : acceptée
- Contexte : le cadrage prévoyait le Claude Agent SDK « sous réserve de
  validation ». Les trois opérations IA du MVP sont des appels uniques à sortie
  structurée (storyboard, plan, revue d'images), sans outils ni accès fichiers.
- Options envisagées : Claude Agent SDK (harnais Claude Code avec outils
  fichiers/bash intégrés) ; API Messages via `@anthropic-ai/sdk`.
- Décision et justification : API Messages (`messages.parse` + Zod). Le SDK
  agent apporterait des outils système inutiles et une surface d'exécution
  plus large, contraire à SECURITY (code IA non fiable).
- Conséquences : aucune boucle agentique côté serveur ; si un agent outillé
  devient nécessaire, réévaluer le SDK agent dans un bac à sable dédié.
  Chemin réel non vérifié faute de clé.

## D008 — Fusion des migrations non publiées

- Date : 2026-10-28
- Statut : acceptée
- Contexte : l'ajout de `failed` (CHECK) et de `parent_revision_id` imposait une
  reconstruction de `video_revisions`, impossible dans la transaction du
  migrateur avec clés étrangères actives.
- Décision et justification : aucune migration n'ayant été commitée ni appliquée
  à une base utile, les migrations 0000–0002 sont remplacées par une migration
  initiale régénérée ; le test de mise à niveau correspondant est retiré.
- Conséquences : à partir du premier commit, les migrations sont additives et
  ne se réécrivent plus.

## D009 — La configuration désigne les secrets par nom

- Date : 2026-10-28
- Statut : acceptée
- Contexte : `models.json` résolvait `env:ANTHROPIC_API_KEY`, ce qui rendait la
  clé obligatoire même en mode simulé et faisait transiter le secret par la
  configuration chargée.
- Décision et justification : `apiKeyEnv` contient le nom de la variable ;
  seul le SDK lit la valeur. Les références `env:` restent supportées par le
  ConfigLoader pour d'autres usages, avec masquage.
- Conséquences : l'interface n'affiche que la présence de la clé.

## D010 — `claude-subscribe` en mode assisté uniquement

- Date : 2026-10-28
- Statut : acceptée (choix de l'utilisateur)
- Contexte : utiliser l'abonnement Claude de l'utilisateur sans clé API. La page
  officielle [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
  (consultée le 2026-10-28) indique qu'Anthropic ne permet pas aux développeurs
  « d'offrir la connexion Claude.ai dans leurs applications » ni « de faire passer
  des requêtes par des identifiants Free, Pro ou Max pour le compte de leurs
  utilisateurs », ni de collecter ou relayer des identifiants ; elle n'empêche pas
  un utilisateur de se connecter au binaire Claude Code non modifié avec son
  propre abonnement. La [présentation de l'Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
  demande l'authentification par clé API pour les produits tiers, sauf accord.
- Options envisagées : appel direct de `claude -p` par le serveur (zone grise,
  acceptable seulement pour un outil strictement personnel) ; Agent SDK avec
  connexion Claude.ai (exclu) ; mode assisté.
- Décision et justification : mode assisté. Veyra écrit `request.json` (et les
  images annotées) dans `projects/<prj>/ai-tasks/<tsk>/` ; l'utilisateur lance
  lui-même Claude Code (skill `veyra-assisted-task`), qui écrit `result.json` ;
  Veyra le valide par Zod puis l'importe. Veyra ne lance jamais de requête modèle,
  ne lit aucun fichier d'identifiants et n'en stocke aucun. La vérification de
  disponibilité exécute seulement `claude --version` et `claude auth status --json`
  et ne garde que `loggedIn`, `authMethod`, `subscriptionType`.
- Conséquences : une étape manuelle par demande (lancer Claude Code) ; pas de
  revue qualitative automatique dans ce mode (rien n'est envoyé). L'appel direct
  reste possible plus tard uniquement par décision explicite et pour un usage
  personnel. Depuis T137 (2026-11-04), l'import est automatique : le serveur
  examine toutes les 2 s les tâches en attente et passe chaque `result.json`
  stable (taille et date inchangées entre deux passages, fichier régulier, pas de
  lien) par la même validation que le bouton « Importer le résultat », conservé
  en repli ; une version invalide n'est retentée que si le fichier change. Le
  lancement de Claude Code reste manuel.

## D011 — Fournisseur explicite, jamais de basculement

- Date : 2026-10-28
- Statut : acceptée
- Contexte : trois fournisseurs (`fake`, `anthropic-api`, `claude-subscribe`) ;
  Claude Code utilise une `ANTHROPIC_API_KEY` présente plutôt que l'abonnement.
- Décision et justification : le fournisseur vient de `VEYRA_AI_PROVIDER`
  (verrouillé), sinon du choix enregistré dans `/settings` (`app_settings`),
  sinon de `defaultProvider` (null par défaut). Un fournisseur indisponible rend
  l'IA indisponible ; un lot garde son fournisseur et échoue plutôt que d'en
  utiliser un autre. La présence d'une clé ne sélectionne plus l'API.
- Conséquences : avant, une clé suffisait à activer Claude ; il faut désormais
  choisir `anthropic-api`. Les identifiants `fake-test-only` et `anthropic`
  persistés sont renommés par la migration 0001.

## D012 — Index de frame mesuré, rendu à fréquence constante

- Date : 2026-10-28
- Statut : acceptée
- Contexte : un `seek` HTML5 ne garantit pas l'image affichée ; les fréquences
  peuvent être fractionnaires (30000/1001).
- Décision et justification : chaque rendu enregistre `media` (fréquence
  rationnelle `r_frame_rate`, durée, `start_time`, nombre de frames, CFR si
  fréquences nominale et moyenne égales). Le lecteur cherche le milieu de la frame
  et lit l'image réellement présentée via `requestVideoFrameCallback` ; le
  serveur extrait la frame annotée par index (`select=eq(n,N)`), et cette capture
  fait foi. Les rendus HyperFrames sont CFR ; en VFR, le lecteur signale une
  sélection approximative.
- Conséquences : l'indexation VFR par timestamps de présentation reste à faire
  si des médias importés sont un jour annotés.

## D013 — Lots de corrections idempotents et QA comparatif déterministe

- Date : 2026-10-28
- Statut : acceptée
- Contexte : plusieurs annotations doivent produire une seule demande, sans
  double envoi ni perte en cas d'erreur, et la correction doit être vérifiée.
- Décision et justification : `correction_batches` avec `submission_key` unique
  (clé générée par le formulaire) ; seuls des brouillons d'une même révision sont
  pris, dans une transaction. Après application, `verifyCorrections` compare les
  valeurs du storyboard au patch et les frames avant/après (PSNR ffmpeg, seuil
  configurable) ; les scènes non ciblées sont comparées pour les régressions.
- Conséquences : un changement visible mais non voulu (ex. style) n'est pas
  détecté sur les scènes ciblées ; le verdict qualitatif multimodal comparatif
  reste à faire (T034).

## D014 — Migration 0001 additive

- Date : 2026-10-28
- Statut : acceptée
- Contexte : la migration 0000 a été appliquée à des bases locales (dev, E2E).
- Décision et justification : 0000 n'est plus modifiée. 0001 ajoute
  `correction_batches`, `ai_tasks`, `app_settings`, `video_revisions.media` et
  reconstruit `feedback` (nouvelles colonnes et nouveau CHECK de statut), en
  copiant les lignes : `open`→`draft`, `planned`→`submitted`,
  `resolved`→`applied`. Couvert par `migration.test.ts`.
- Conséquences : le statut `resolved` disparaît ; l'approbation humaine reste
  portée par la révision.

## D015 — Expertise QA par `QualityEvaluator`, consultative et séparée des mesures

- Date : 2026-10-28
- Statut : acceptée
- Contexte : le QA comparatif (D013) mesure qu'un changement a eu lieu (storyboard,
  PSNR) mais pas qu'il correspond à l'intention : une entrée accélérée au lieu de
  ralentie ressort « appliquée » (constaté sur rendu réel, voir TESTING).
- Décision et justification : interface `QualityEvaluator` (`packages/ai/src/evaluation.ts`)
  indépendante du fournisseur ; chaque fournisseur fournit la sienne :
  `fake` → règles sur les storyboards, `simulated`, aucune image ; `anthropic-api` →
  images envoyées, `multimodal` (ou `text-only` sans image), non vérifié ;
  `claude-subscribe` → requête `evaluation` exportée, `multimodal` seulement si
  `imagesExamined` (filtré sur le dossier de preuves) n'est pas vide, étiqueté
  « déclaré par Claude Code ». Dossier de preuves : capture exacte annotée, frame
  alignée de la nouvelle révision (même décalage dans la scène, scènes déplacées
  prises en compte), séquences de 5 frames pour les changements de timing, milieu
  des scènes non ciblées ; plus brief, consignes de marque, storyboards, plan et
  mesures (étiquetées comme telles). Verdicts par commentaire avec catégorie
  (`technical`, `content`, `aesthetic`), confiance et preuves ; verdict
  `contradicts_request` ajouté. Résultats dans `quality_evaluations` (migration 0002).
- Conséquences : l'expertise ne change ni les révisions ni leur état, ne déclenche
  aucune correction et n'efface pas les mesures : désaccords affichés. Fournisseur
  absent ou indisponible → évaluation `unavailable`, jamais remplacée par une
  simulation. En mode assisté, l'examen des images est déclaré par Claude Code,
  non prouvable par Veyra.

## D016 — Consolidation de l'expertise QA v0.1 : langue, présentation, références

- Date : 2026-10-28
- Statut : acceptée
- Contexte : rendre l'expertise QA (D015) lisible, honnête et mesurable sans
  changer son architecture.
- Décision et justification :
  - Langue des textes d'expertise : `config/quality.yaml` → `reportLanguage`
    (`fr` par défaut, `en`), transmise aux consignes des évaluateurs et aux textes
    du simulateur. L'interface reste en français.
  - Rapport en trois parties : conformité aux corrections, qualité technique et
    artistique globale, régressions potentielles ; preuves citées et preuves
    fournies non examinées affichées par commentaire.
  - Confiance présentée comme « estimée par le modèle » (ou « fixe du simulateur »),
    jamais comme une probabilité.
  - Garde-fou à la persistance (`qualityEvaluationSchema`) : `fake` ⇒ `simulated` ;
    `simulated` ⇒ `fake` ; `multimodal` ⇒ au moins une image examinée ;
    `deterministic` refusé ; évaluation terminée ⇒ mode déclaré. L'affichage
    étiquette `fake` « Simulée » quoi qu'il arrive.
  - Jeu de référence versionné `qa/reference/v1/` (10 cas, dont le cas réel de la
    revue indépendante avec ses images réduites en 960 px) et commande `pnpm qa:bench`
    (exactitude par catégorie et par verdict, matrice de confusion, erreurs
    critiques = acceptation à tort, régression manquée, commentaire sans verdict).
  - `tsx` 4.23.15 (MIT) en dépendance de développement de `@veyra/ai` pour exécuter
    la commande sur les sources TypeScript du workspace.
- Conséquences : les verdicts attendus ont été rédigés par l'agent de développement
  (`validation.status: proposed`, `reviewedBy: null`) ; ils doivent être validés par
  un humain avant de servir de référence. Le score du simulateur ne mesure que ses
  règles, écrites pour les mêmes formulations.

## D017 — Composants animés maison, déclarés en données

- Date : 2026-10-29
- Statut : acceptée
- Contexte : passer de scènes texte à un motion design paramétrable sans laisser
  l'IA écrire de code. HyperFrames 0.8.209 propose un catalogue (`catalog`, `add`)
  de blocs et composants tiers, et des sous-compositions avec variables.
- Options envisagées : composants du catalogue HyperFrames (téléchargement réseau
  de code tiers exécuté au rendu, licences non vérifiées) ; sous-compositions avec
  script lisant `getVariables()` ; composants maison générant HTML + données
  d'animation.
- Décision et justification : registre maison `@veyra/motion`, versionné ; chaque
  composant produit du HTML échappé et des tweens/compteurs validés par Zod, écrits
  en JavaScript uniquement par le compositeur fixe ; une seule composition racine,
  scènes = clips. Le catalogue tiers n'est ni installé ni exécuté. Les scènes texte
  existantes gardent leur rendu (aucune régression des anciennes révisions).
- Conséquences : `hyperframes check` s'exécute avant chaque rendu et alimente le QA ;
  les nouveaux rendus automatiques sont limités aux défauts de sortie vidéo (durée,
  résolution, fps, codec, fichier vide, noirs), un défaut de mise en page demandant
  une correction. Avertissement HyperFrames sur les sous-compositions accepté pour
  l'instant (T071). Aucune migration : le composant vit dans le JSON du storyboard.

## D018 — Skills HyperFrames par le plugin officiel figé sur un tag

- Date : 2026-10-29
- Statut : acceptée (choix de l'utilisateur : ignorer les copies installées)
- Contexte : 7 skills HyperFrames ont été copiés dans `.agents/skills/` par
  `npx skills add`, avec `skills-lock.json`, et le plugin `hyperframes@hyperframes`
  était activé dans `.claude/settings.json`. Le verrou ne contient ni tag ni commit ;
  `hyperframes skills update` et `npx skills add` suivent la branche principale ; deux
  copies portant la même version 0.8.214 différaient d'un fichier.
- Options envisagées : versionner les copies (redistribution, ~4 Mo) ; garder
  `skills-lock.json` (détecte un écart mais réinstalle la dernière version) ; plugin
  Claude Code officiel avec marketplace figée.
- Décision et justification : plugin officiel, marketplace déclarée dans
  `.claude/settings.json` avec `ref: v0.8.214` et `sparsePaths` (fichier écrit par
  `claude plugin marketplace add … --scope project`, portable : ni secret ni chemin
  local). Copies et verrou ignorés par git, répertoire par répertoire.
- Conséquences : restauration vérifiée le 2026-10-29 dans un clone neuf avec une
  configuration Claude Code isolée : commit 4719543 (= tag), skills identiques au
  tag, version inchangée après `marketplace update` et `plugin update`. Une étape
  manuelle par clone (RUNBOOK). Écart de version avec le CLI de rendu (0.8.209), levé
  le même jour : CLI aligné sur 0.8.214 (rendus identiques au pixel, voir TESTING).

## D019 — Orchestrateur persisté mono-processus et enveloppes validées par phase

- Date : 2026-10-29
- Statut : acceptée
- Contexte : un audit d'architecture de la v0.3 a relevé un run bloqué après un
  arrêt brutal, des payloads de phase jamais validés, une attribution `director`
  fictive des phases `engine`/`human`, une garde CFR jamais appelée hors tests,
  un budget `maxRenders` déclaré mais non appliqué et un commentaire promettant
  plus d'idempotence que le code n'en fournit.
- Options envisagées : file de tâches multi-processus avec verrous ; cache des
  phases par `inputHash` entre runs ; orchestrateur unique en mémoire adossé à
  SQLite.
- Décision et justification : orchestrateur unique par processus Studio, état
  persisté dans SQLite (runs, phases, transitions de `core.ts`) ; un run `running`
  sans exécution en mémoire est orphelin et reprend. Chaque résultat est une
  enveloppe d'agent (`agent` métier, `engine` ou `human`) dont le payload est
  validé par le contrat de sa phase avant persistance ; un écart fait échouer la
  phase (`validation: invalid`, `errors`). Un ancrage audio unique : `absolute`
  (fixe) ou `event` (suit la scène), sans mélange. CFR uniquement : VFR refusé, et
  un CFR non mesuré n'est pas supposé. Idempotence : une phase terminée n'est
  jamais rejouée dans son run ; aucun cache entre runs par hash (`inputHash` est
  une provenance). Plus simple et vérifiable qu'une file distribuée, suffisant
  pour un Studio local.
- Conséquences : pas de coordination multi-processus ; deux processus sur la même
  base ne doivent pas piloter le même run. Les fenêtres de ducking absolues et les
  ancrages inrésolus sont signalés `needs-human` avant rendu, pas corrigés.
  Détail : [MULTI-AGENT-ARCHITECTURE](ai/MULTI-AGENT-ARCHITECTURE.md).

## D021 — Director outillé par pas structurés bornés (complète D007 et D019)

- Date : 2026-11-04
- Statut : **proposée** (architecture validée sur le principe par l'utilisateur ;
  implémentation en T128–T129)
- Contexte : Veyra doit devenir un studio de montage où l'IA choisit et utilise les
  outils disponibles, sans enchaînement de phases imposé. D007 exclut toute boucle
  agentique côté serveur ; D019 exclut tout cache entre runs et définit un orchestrateur
  persisté mono-processus.
- Options envisagées : Claude Agent SDK (outils système, surface trop large) ; boucle
  d'usage d'outils natif multi-tours ; **pas successifs à sortie structurée** dont chaque
  action est validée, autorisée et exécutée par Veyra.
- Décision et justification : pas successifs à sortie structurée ([DIRECTOR-TOOL-LOOP](ai/DIRECTOR-TOOL-LOOP.md)).
  D007 est **conservée** sur l'essentiel : chaque décision reste une donnée validée par
  Zod ; le modèle ne reçoit aucun outil système ; seules les capacités du registre
  ([TOOL-REGISTRY](ai/TOOL-REGISTRY.md)) sont appelables, par Veyra. D019 est **étendue** :
  la boucle tourne dans une phase d'un run, chaque transition d'appel est persistée,
  la reprise suit les mêmes règles ; un cache de rendu par scène fera l'objet d'une
  décision séparée (T130).
- Conséquences : bornes de pas, d'appels, de temps, de rendus et de coût ; aucune action
  payante, réseau ou de code généré sans confirmation explicite **de cette action** ;
  QA Expert hors de la boucle ; validation humaine finale ; code généré (niveau 2 de
  [CREATIVE-COMPOSITION](ai/CREATIVE-COMPOSITION.md)) refusé jusqu'à une décision dédiée
  après durcissement de la sandbox.

## D022 — Enveloppe budgétaire stricte par production

- Date : 2026-11-10
- Statut : acceptée (T138)
- Contexte : avec `anthropic-api`, chaque appel est facturé sur la clé de
  l'utilisateur. Le compteur `maxAiCalls` (D019) borne le nombre d'appels, pas leur
  coût ; T133 demandait un budget unique, décompté avant l'appel, y compris hors run.
- Décision : tout appel facturable (storyboard, plan de correction, revue qualitative,
  expertise QA) passe par un run et son enveloppe en micro-dollars entiers
  (`budgetMicroUsd`, 0 par défaut = aucun appel). Avant l'appel, l'entrée est comptée
  par `messages.countTokens` (même modèle, consigne et messages ; appel réseau non
  facturé), puis le pire cas est réservé par `reserveBudget`, seul point de contrôle,
  transactionnel : entrée × 1,25 × prix d'entrée + `max_tokens` × prix de sortie
  (`max_tokens` envoyé = celui de la réservation, `maxTokens` de `config/models.json`).
  Après l'appel, `settleBudget` remplace la réservation par le coût de
  `response.usage` ; en erreur ou annulation (coût inconnu), la réservation est
  gardée comme dépensée. `countTokens` n'est appelé que si l'enveloppe couvre au moins
  `max_tokens` × prix de sortie : une enveloppe à 0 ne déclenche aucun appel réseau.
  Un appel hors des phases d'un run (plan d'un lot, revue d'un rendu, expertise QA)
  est imputé au run qui a produit la révision (`origin.runId`, ou le run dont
  `revisionId` est cette révision) ; sans run, il est refusé explicitement.
  Dépassement : phase en échec avec le message de `BudgetExceededError`, sans nouvel
  essai ; « Reprendre » fonctionne après augmentation (`raiseBudget`, jamais à la
  baisse, jamais au-delà de `maxBudgetUsd` de `config/models.json`, 20 $ par défaut).
  Exception (T145) : la revue qualitative d'un rendu est optionnelle ; un refus de
  l'enveloppe ou toute erreur de son appel la marque « Revue IA non effectuée :
  <raison> » (`not-performed`), sans faire échouer le rendu : MP4 et QA déterministe
  conservés, révision en attente de validation humaine.
  « Arrêter » annule l'appel en cours (un `AbortController` par run, retiré quand le
  run est terminé, en échec ou arrêté).
  Client SDK : clé et `baseURL` passés explicitement (clé depuis `$app/env/private`,
  point d'accès depuis `baseUrls` de `config/models.json` ; le SDK ne lit ni la clé ni
  `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` dans `process.env`), `maxRetries: 0` (un nouvel essai automatique pourrait facturer deux
  fois), délai par appel `callTimeoutMs` (120 s). Le repli serveur
  (`server-side-fallback`) est retiré : la réservation est calculée pour le modèle
  demandé seulement ; aucun repli de fournisseur non plus (D011).
- Justification : la réservation du pire cas rend le dépassement impossible par
  construction, même avec plusieurs appels dans un run ; les entiers évitent les
  erreurs d'arrondi cumulées.
- Conséquences et limites : le coût n'est exact que si la grille locale
  (`pricing` de `config/models.json`, source et date de vérification affichées dans
  `/settings`) suit la page Pricing d'Anthropic ; un modèle sans tarif est refusé.
  Une réservation en cours lors d'un arrêt brutal reste réservée, de même qu'une
  réservation dont le règlement échoue (journalisé sans contenu, l'erreur ou la
  réponse d'origine est conservée). Le pire cas du
  formulaire de prompt est une estimation locale (un jeton par octet, prompt ≤ 4 Ko).
  Remplace, pour les appels du fournisseur, la confirmation « de cette action » de
  [DIRECTOR-TOOL-LOOP § 4](ai/DIRECTOR-TOOL-LOOP.md#4-bornes-et-garde-fous) : l'enveloppe
  saisie par l'utilisateur pour la production vaut autorisation, dans sa limite.

## D023 — Fournisseurs OpenAI et Codex

- Date : 2026-11-10
- Statut : acceptée (choix de l'utilisateur ; T139–T141)
- Contexte : étude [OPENAI-CODEX-INTEGRATIONS](research/OPENAI-CODEX-INTEGRATIONS.md)
  (sources consultées le 2026-11-04). La clé API OpenAI est la voie recommandée par
  OpenAI pour l'automatisation (**AUTORISÉ**) ; piloter Codex avec le compte ChatGPT
  de son titulaire n'est ni autorisé ni interdit explicitement (**AMBIGU**), les
  Terms of Use n'ayant pas pu être lus (403).
- Décision :
  - `openai-api` : autorisé par clé (`OPENAI_API_KEY`, lue seulement par
    `$app/env/private`, passée explicitement au SDK `openai` 7.47.0, `maxRetries: 0`,
    `{ signal, timeout }`). Responses API, `store: false`, sortie structurée
    (`zodTextFormat` strict quand le schéma s'y prête, sinon `json_schema` non strict),
    toujours revalidée par Zod. Même enveloppe que D022 : sans équivalent sourcé et
    gratuit de `countTokens`, l'entrée est bornée hors ligne par un jeton par octet
    UTF-8 (consigne, schéma, texte, libellés) + 256 jetons de cadrage ; le coût
    constaté vient de `usage`. Images refusées tant qu'aucune borne de jetons d'image
    n'est sourcée. Sans modèle configuré (`openai.model`) ni tarif sourcé dans
    `pricing`, le fournisseur est **indisponible** (aucun tarif inventé).
  - `codex-chatgpt` : statut AMBIGU **accepté par l'utilisateur le 2026-11-04** ;
    désactivé par défaut. Conditions d'activation, toutes de l'utilisateur :
    installer Codex, `codex login` avec son compte ChatGPT, renseigner le chemin
    absolu du binaire (`codexChatgpt.command`), puis « Activer Codex » dans
    `/settings`. Avant cela, Veyra ne lance aucun processus Codex et affiche
    « Indisponible » avec la raison. Exécution par l'exécuteur unique `runProcess` :
    `codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config
    --ignore-rules --sandbox read-only --output-schema … --output-last-message …`,
    `-c approval_policy="never"`, `features.shell_tool=false`,
    `tools.web_search=false`, `features.view_image=false`,
    `forced_login_method="chatgpt"` ; dossier de travail temporaire vide ; sortie
    validée par Zod. Coût « abonnement » : pas d'enveloppe en dollars, limites du plan
    affichées.
  - Capacités déclarées par fournisseur (statique, Zod) ; un fournisseur indisponible
    n'est pas sélectionnable ; aucun repli (D011).
- Protections : env de Codex en liste blanche (`PATH` fixe, `LANG`, `HOME`,
  `CODEX_HOME`) ; refus de démarrer si `OPENAI_API_KEY` ou `CODEX_API_KEY` y figure
  (ordre de priorité clé/abonnement non documenté) ; délai et « Arrêter » tuent le
  groupe de processus ; aucune lecture de `~/.codex` ni d'identifiants par Veyra ;
  sonde limitée à `codex --version` et `codex login status` (code de sortie seul).
- Conséquences et limites : aucun des deux fournisseurs n'a été appelé réellement
  (clients et binaire simulés). `codex login status` et le séparateur `--` avant le
  prompt ne sont pas documentés dans le rapport : à vérifier à l'installation. Les
  surcharges `-c` sont tirées de la référence de configuration, sans test réel de
  leur effet. Tarifs OpenAI et coût des images : non sourcés.
