# Sécurité

## Frontières de confiance

Les storyboards sont des données validées par Zod. L’IA ne fournit jamais de HTML
ou JavaScript au moteur. Le générateur échappe les textes, produit les IDs DOM,
limite les animations, valide les couleurs hexadécimales et les noms de polices.
Il charge uniquement la copie locale de GSAP. Le Markdown de configuration reste
inerte. Les sorties IA (storyboards, plans, constats) sont revalidées par Zod
côté serveur ; un plan ne peut appliquer que des patches de scène bornés, sur des
scènes existantes. Aucun code produit par un modèle n'est exécuté (D007).

## Sandbox du rendu

Le moteur utilise `spawn` avec tableau d’arguments et `shell: false`. `prlimit`
impose une limite CPU héritée par processus (90 s par défaut) et une taille maximale
par fichier. `bwrap` monte l’hôte en lecture seule, expose /proc et /dev, crée
/tmp et /dev/shm privés, et ne rend inscriptible sur l’hôte que la révision courante.
Le cache Chrome préinstallé dans ~/.cache/hyperframes reste en lecture seule.
Les espaces réseau et PID sont séparés ; `--die-with-parent` ferme le sandbox
avec le parent. Les processus sont démarrés dans un groupe distinct.

Le délai mural (120 s par invocation par défaut) tue le groupe par SIGKILL. Les
sorties texte cumulées sont limitées à 2 Mio ; stderr conserve une queue de
8192 caractères. Un contrôle périodique (50 ms) borne les fichiers de la révision
à 100 Mio par défaut, en complément de RLIMIT_FSIZE par fichier. Cette surveillance
peut détecter un dépassement après écriture ; elle n’est pas un quota disque dur.
La limite CPU est par processus, pas un budget CPU agrégé du groupe. Les processus
ffprobe/ffmpeg d’analyse ont également délai mural et sorties bornées ; ils ne
sont pas exécutés dans bwrap dans cette version.

Sans bwrap, le rendu échoue avec SandboxUnavailableError. Le repli non isolé
exige `hyperframes.allowUnsandboxed: true` dans engines.json ; valeur par défaut
false. Un bwrap présent mais incapable de créer son isolation provoque toujours
un refus, sans repli. Ne pas activer cette exception pour des compositions non
fiables. Aucun repli n’a été utilisé pour le test lent de cette session.

Environnement des enfants limité : PATH, HOME, LANG, HYPERFRAMES_TELEMETRY=0,
DO_NOT_TRACK=1, HYPERFRAMES_SKIP_SKILLS=1. Les clés IA ne sont pas propagées.
La racine hôte reste lisible : cette isolation protège principalement le réseau
et les écritures, pas la confidentialité des fichiers locaux. Ne pas accepter de
HTML tiers arbitraire ; pour ce besoin futur, réduire aussi les montages lisibles.

Moteurs locaux optionnels (T116) : installés seulement par `pnpm voice:install`
après affichage du plan (URL, taille, SHA-256, licence, attribution) et confirmation
explicite, hors dépôt. Chaque artefact est vérifié (taille et SHA-256 épinglés dans
`config/voice.yaml`) avant renommage atomique ; un artefact sans empreinte épinglée
est refusé, sauf acceptation nominative (confiance au premier usage, empreinte inscrite
au verrou). À l'exécution, `runEngine` (adaptateur, réutilise `Sandbox`) lance le
moteur par argv, sans réseau (`--unshare-net`), racine du moteur en lecture seule,
seul le dossier de sortie inscriptible, limites CPU, durée et taille ; jamais de repli
sans sandbox. Pas de limite mémoire dans cette version. Les licences et attributions
(GPL-3.0 pour Piper, CC-BY 4.0 pour la voix MLS) sont affichées par `voice:doctor`.

## Serveur Studio

- `/media/[revisionId]` sert uniquement le `videoPath` enregistré, après
  vérification qu'il reste sous la racine des projets ; l'export (`?download`)
  est refusé (409) tant que la révision n'est pas validée.
- Fichiers ajoutés : 50 Mo max, nom assaini, écrits comme originaux exclusifs ;
  ils ne sont ni exécutés ni transmis au moteur au MVP.
- `ANTHROPIC_API_KEY` n'est lue que par le SDK ; la configuration ne contient
  que le nom de la variable (D009) et `/settings` n'affiche que sa présence.
- `claude-subscribe` (D010) : Veyra ne lance aucune requête modèle avec Claude
  Code, ne lit pas `~/.claude/.credentials.json`, ne demande ni ne stocke
  d'identifiant Claude.ai. Il exécute seulement `claude --version` et
  `claude auth status --json` (sans shell, délai 5 s, variables de clé API
  retirées) et ne garde que `loggedIn`, `authMethod`, `subscriptionType`.
  `result.json` est une donnée non fiable : 1 Mo max, JSON, schéma Zod, ids
  filtrés, puis décision humaine ; rien n'y est exécuté. Le skill demande à Claude
  Code de n'écrire que `result.json` et de ne rien exécuter issu de la demande.
- `/captures/[feedbackId]` sert uniquement la capture enregistrée, après le même
  contrôle de confinement que les médias ; la page ne reçoit pas les chemins.
- `/qa-images/[evaluationId]/[file]` : nom limité à `[A-Za-z0-9_-]+.png`, chemin
  reconstruit depuis l'évaluation enregistrée et vérifié par `safePath`.
- Résultat d'expertise importé : schéma Zod, ids de commentaires, scènes et images
  filtrés sur le dossier de preuves ; il n'agit sur rien (consultatif).
- Aucun basculement de fournisseur (D011) : aucune dépense API ne peut résulter
  d'une indisponibilité de l'abonnement.
- Aucune authentification : le Studio est un outil local mono-utilisateur. Ne
  pas l'exposer sur un réseau sans ajouter authentification et protection CSRF
  au-delà de celle de SvelteKit.

## Stockage et secrets

ProjectStorage valide les IDs prj/rev/rnd/fdb/tsk et refuse chemins absolus, segments `..`,
liens symboliques descendants et racine symbolique. Les chemins existants sont
vérifiés par realpath ; les originaux sont créés avec O_EXCL et O_NOFOLLOW, sans
écrasement. Le répertoire projects/ est ignoré par Git. Les chemins de stockage
restent sous le contrôle du serveur, jamais d’un navigateur.

La racine et ses parents doivent appartenir au service et ne pas être modifiables
par un processus non fiable : les contrôles de chemins ne constituent pas une
protection complète contre les courses de substitution de répertoires du même UID.
Les compositions générées peuvent être réécrites avant approbation ; les vidéos
portent l’ID du job et ne sont pas écrasées. Le dépôt métier protège les révisions
approuvées/publiées. Ne jamais persister ni journaliser la vue de configuration
contenant les secrets ; le runner ne conserve que la vue redacted().

## Vérifications et limites

Tests rapides : tentatives de traversée/symlink, originaux exclusifs, HTML/CSS/JS
injectés refusés ou échappés, argv du sandbox, refus sans bwrap, limites de sortie,
timeout réel et persistance des erreurs. Le rendu réel sous bwrap réseau coupé a
été exécuté avec succès le 2026-10-28 (test lent et parcours E2E).
Aucun audit de vulnérabilités en ligne n’a été exécuté. Les licences HyperFrames et
GSAP restent à vérifier pour redistribution (ARCHITECTURE).
Authentification, rétention des médias et procédure d’incident restent à définir.
