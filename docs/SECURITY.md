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
Les espaces réseau, PID, IPC, UTS et cgroup (si possible) sont séparés ;
`--die-with-parent` ferme le sandbox avec le parent. Les processus sont démarrés
dans un groupe distinct ; `--new-session` détache le sandbox du terminal (pas de
TIOCSTI). Depuis T136b, `/run` est un tmpfs vide (monté juste après la racine) :
les sockets de l'hôte sous `/run/user/$UID` (D-Bus de session, gnupg, pulse) et
`/run/dbus` ne sont plus visibles ; les sockets abstraites relèvent de l'espace
réseau séparé. Limite : une socket Unix sous un chemin monté en lecture seule (par
exemple `$HOME`, conservé pour le cache Chrome) reste connectable.

Le délai mural (120 s par invocation par défaut) tue le groupe par SIGKILL. Les
sorties texte cumulées sont limitées à 2 Mio ; stderr conserve une queue de
8192 caractères. Un contrôle périodique (50 ms) borne les fichiers de la révision
à 100 Mio par défaut, en complément de RLIMIT_FSIZE par fichier. Cette surveillance
peut détecter un dépassement après écriture ; elle n’est pas un quota disque dur.
La limite CPU est par processus, pas un budget CPU agrégé du groupe. Les processus
ffprobe/ffmpeg d’analyse ont également délai mural, sorties bornées et prlimit
(voir « Exécuteur de processus ») ; ils ne sont pas exécutés dans bwrap dans cette
version.

Sans bwrap, le rendu échoue avec SandboxUnavailableError. Le repli non isolé
exige `hyperframes.allowUnsandboxed: true` dans engines.json ; valeur par défaut
false. Un bwrap présent mais incapable de créer son isolation provoque toujours
un refus, sans repli. Ne pas activer cette exception pour des compositions non
fiables. Aucun repli n’a été utilisé pour le test lent de cette session.

Environnement du rendu : PATH, HOME, LANG=C.UTF-8, HYPERFRAMES_TELEMETRY=0,
DO_NOT_TRACK=1, HYPERFRAMES_SKIP_SKILLS=1 (plus PWD posé par bwrap), construit par
l'exécuteur ci-dessous. La racine hôte reste lisible : cette isolation protège principalement le réseau
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

## Exécuteur de processus (T132)

Avant T132, `runProcess` transmettait tout `process.env` (clés API, jetons) aux
ffmpeg/ffprobe de `packages/video`, et `probe()` lisait ses entrées sans
`-protocol_whitelist file`. Désormais, tout processus externe du runtime passe par
`runProcess` (`packages/video/src/process.ts`), sauf la vérification `claude`
(ci-dessous) :

- argv seulement, `shell: false`, groupe de processus distinct tué par SIGKILL au
  délai mural, sorties bornées ; commandes `sh`/`bash`/`env`/… et commandes
  commençant par `-` refusées ;
- environnement **jamais hérité** : `PATH` fixe et `LANG=C`, plus les ajouts explicites
  de l'appelant pris dans une liste blanche (`HOME`, `LANG`, `LC_ALL`, `TZ`,
  `HYPERFRAMES_TELEMETRY`, `HYPERFRAMES_SKIP_SKILLS`, `DO_NOT_TRACK`,
  `CLAUDE_CONFIG_DIR`) ; une clé ressemblant à un secret (`ANTHROPIC_*`,
  `CLAUDE_CODE_*`, `AWS_*`, `GITHUB_*`, `OPENAI_*`, `*_TOKEN`, `*_KEY`, `*_SECRET`,
  `*_PASSWORD`, `*_CREDENTIAL(S)`) ou hors liste lève une erreur avant tout lancement ;
- `PATH` fixe (T136b) : `<dossier de node>:/usr/local/bin:/usr/bin:/bin`
  (dédoublonné), jamais le `PATH` du parent ni ses dossiers inscriptibles par
  l'utilisateur (`~/.local/bin`…) ; les tests injectent leurs enregistreurs par
  `setChildPathPrefixForTests`, qui lève une erreur hors Vitest ;
- `ffmpeg`/`ffprobe` (selon le nom de base, `/usr/bin/ffmpeg` compris) sont lancés sous `prlimit` par défaut (CPU 600 s, fichier 2 Gio,
  espace d'adressage 8 Gio : filet de sécurité, le délai mural reste la borne
  principale) ; `runAudioProcess` garde ses propres limites (`config/audio.yaml`) et
  `Sandbox`/`runEngine` les leurs, sans limite d'espace d'adressage (Chrome) ;
- `streamFrames` (décodage brut) utilise le même exécuteur (consommateur de stdout
  binaire) ; `Sandbox.run`/`runEngine` passent par lui (options bwrap : « Sandbox du rendu »).

Politique de protocoles FFmpeg : chaque entrée média de `packages/video`,
`packages/audio` et du CLI d'aperçus est précédée de `-protocol_whitelist file`
(`fileInput`), et `probe`, `probeVideoStream`, `extractFrame(s)ByIndex`,
`compareFrames` refusent une entrée commençant par `-`, une URL à schéma
(`concat:`, `http:`, `data:`, `file:`…) ou ce qui n'est pas un fichier régulier
(`mediaPath`, avec `lstat` depuis T136b : un lien symbolique est refusé, comme
dans `probeAudio` ; seul le dernier composant est vérifié). Aucun appelant du
runtime ne lit un média par un lien symbolique (rendus et imports sont des fichiers
écrits par le serveur).

Liste blanche de démultiplexeurs (T136b) : chaque entrée fichier reçoit
`-format_whitelist`. Rendus, aperçus, QA (photosensibilité, contraste, images
extraites) : `mov,mp4,m4a,3gp,3g2,mj2` (`VIDEO_FORMATS`) ; `compareFrames` (PSNR
d'images PNG) : `png_pipe` ; toute autre entrée marquée `-protocol_whitelist file`
sans liste propre (chemins audio : import, analyse, mixage, mux) reçoit de
l'exécuteur `MEDIA_FORMATS` = formats de `config/audio.yaml` (wav, mp3, flac, ogg,
famille mov, aiff). Une liste HLS (`.m3u8`) ou un fichier ffconcat, quel que soit
son nom, est refusé (« Format not on whitelist ») avant tout décodage.
Matroska/WebM n'est pas autorisé (aucun appelant). Les générateurs `-f lavfi` construits par le serveur (fixtures, voix
`fake`, `colorEngine`) ne lisent aucun fichier. Les sorties restent sous les
contrôles existants (`safePath`, `ProjectStorage`).

Limites : `runProcess` est une primitive de bas niveau : ses appelants ne doivent
jamais lui passer d'argv contrôlé par le modèle ou l'utilisateur (un graphe lavfi
`movie=` sans marqueur `-protocol_whitelist file` lit encore un fichier) ; pas de
liste blanche de binaires (prévue avec le registre d'outils, T127). `MEDIA_FORMATS`
est codé en dur : ajouter un format à `config/audio.yaml` exige de le reporter (test
de cohérence dans `process-policy.test.ts`).
Vérifications : `packages/video/src/process.test.ts`,
`packages/video/src/process-policy.test.ts` (refus HLS/ffconcat/liens, PATH fixe,
limites par nom de base, risques résiduels épinglés `RESIDUAL`),
`apps/studio/src/lib/server/jobs/process-env.test.ts` (ffmpeg/ffprobe réels derrière
un enregistreur placé en tête du PATH enfant par le crochet de test),
`packages/hyperframes-adapter/src/engine-sandbox.test.ts` (bwrap réel : réseau,
socket sous `/run/user/$UID` invisible, délai mural sous `--new-session`).

## Serveur Studio

- Accès (T136, T136b ; `apps/studio/src/lib/server/access.ts`, appliqué par le plugin
  Vite `accessGuard` de `vite.config.ts` **et** par le hook `src/hooks.server.ts`) :
  serveurs de développement et de prévisualisation sur `127.0.0.1`. La même politique
  passe avant tous les middlewares de Vite (sources `/src`, `/@fs`, `/@vite/client`,
  fichiers statiques, bundle) et coupe la websocket HMR ; SvelteKit ne voit sinon pas
  ces requêtes. Règles : client non local refusé (403), même avec `--host` ; client
  local accepté seulement avec un `Host` de bouclage (`127.0.0.1`, `localhost`, `[::1]`,
  contre le DNS rebinding) ; écritures inter-sites refusées dans tous les modes
  (`Origin` différent ou `Sec-Fetch-Site: cross-site`), car SvelteKit ne contrôle pas
  l'origine en développement. Mode réseau seulement avec `VEYRA_ALLOW_LAN=1` et un
  jeton `VEYRA_ACCESS_TOKEN` (≥ 32 caractères URL-safe) : formulaire (401), jeton en
  POST puis cookie `HttpOnly; SameSite=Strict`, ou `Authorization: Bearer` ; jamais
  dans une URL ni dans le journal ; redirection fixe vers `/` ; comparaison en temps
  constant ; sans jeton valide, aucun client distant n'est servi (503). Proxy : aucun
  en-tête `X-Forwarded-*` n'est cru. Limites : pas de comptes ni de TLS ; un relais
  local (tunnel inverse, proxy) ferait passer ses clients pour la machine locale ;
  l'adaptateur de production (`adapter-auto`) n'est pas choisi. Tests :
  `access.test.ts`, `access.slow.test.ts` (vrais serveurs `vite dev` et `vite preview`).
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
  `claude auth status --json` (sans shell, délai 5 s, environnement limité à
  `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `CLAUDE_CONFIG_DIR` : `HOME` suffit à
  Claude Code 2.1.318 pour lire sa connexion, vérifié le 2026-11-04) et ne garde que `loggedIn`, `authMethod`, `subscriptionType`.
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
