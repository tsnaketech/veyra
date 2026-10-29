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
- Conséquences : une étape manuelle par demande ; pas de revue qualitative
  automatique dans ce mode (rien n'est envoyé). L'appel direct reste possible
  plus tard uniquement par décision explicite et pour un usage personnel.

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
