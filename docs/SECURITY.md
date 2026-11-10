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
Les espaces réseau, PID, IPC, UTS et cgroup (si possible) sont séparés ;
`--die-with-parent` ferme le sandbox avec le parent. Les processus sont démarrés
dans un groupe distinct ; `--new-session` détache le sandbox du terminal (pas de
TIOCSTI). Depuis T136b, `/run` est un tmpfs vide (monté juste après la racine) :
les sockets de l'hôte sous `/run/user/$UID` (D-Bus de session, gnupg, pulse) et
`/run/dbus` ne sont plus visibles ; les sockets abstraites relèvent de l'espace
réseau séparé.

`$HOME` masqué (T127-sec N2, revue du 2026-11-04) : `/home` et `$HOME` (s'il est
ailleurs) sont des tmpfs vides, montés avant la révision. `~/.ssh`,
`~/.claude/.credentials.json`, les sockets sous `~/.config` (par exemple
`~/.config/herdr/*.sock`, qui pilote des terminaux), les autres utilisateurs de
`/home`, le dépôt et sa base `apps/studio/local.db` (s'ils sont sous `/home`) ne sont
plus ni lisibles ni connectables. Seuls sont remontés en lecture seule, et seulement
si le masque les cache : `~/.cache/hyperframes/chrome` (Chrome headless, nécessaire :
sans lui le rendu échoue), `~/.cache/hyperframes/fonts` (Inter hors ligne ; sans lui
le rendu passe mais en police de repli), `~/.local/share/fonts` et `~/.fonts` s'ils
existent, le `node_modules` qui contient le CLI HyperFrames (nécessaire : sans lui
`lint` échoue ; il contient aussi gsap et les autres dépendances, pas de secret) et le
préfixe d'installation de node (nvm…). Le `HOME` de l'environnement reste le vrai
chemin : il pointe sur le tmpfs, inscriptible mais éphémère (`~/.hyperframes` y est
recréé puis perdu). Limites : une socket Unix sous un chemin remonté en lecture seule
(racine d'un moteur, caches ci-dessus) reste connectable (`RESIDUAL` dans
`engine-sandbox.test.ts`) ; hors de `/home`, la racine hôte reste lisible (un dépôt
installé ailleurs, `/etc`, `/var`, `/opt`) ; le réseau est coupé, mais la vidéo
produite reste un canal de sortie ; les tmpfs (`/tmp`, `$HOME`) ne sont pas bornés en
taille (bwrap 0.8 sans `--size`).

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
l'exécuteur ci-dessous. Hors de `/home`, la racine hôte reste lisible : cette
isolation protège le réseau, les écritures et les secrets de l'utilisateur, pas la
confidentialité de tout le système de fichiers. Ne pas accepter de HTML tiers
arbitraire ; pour ce besoin futur, réduire aussi les montages lisibles.

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
- binaires en chemins absolus (T127-sec N8) : une commande nue (`ffmpeg`, `ffprobe`,
  `prlimit`, `bwrap`…) est résolue une fois (`systemBinary`) dans `/usr/local/bin`,
  `/usr/bin`, `/bin`, dans cet ordre, jamais dans le `PATH` du parent ni dans le
  dossier de node ; introuvable, elle est refusée. La commande enveloppée par
  `prlimit … -- ffmpeg` (chemins audio) est résolue de même, et les défauts
  `bwrapPath`/`prlimitPath` de la sandbox aussi ;
- `PATH` enfant fixe : `/usr/local/bin:/usr/bin:/bin:<dossier de node>`
  (dédoublonné) ; le dossier de node vient en dernier (utile seulement aux enfants
  node comme HyperFrames, qui cherchent `ffmpeg` dans le `PATH`) ; jamais le `PATH`
  du parent (`~/.local/bin`…). Les tests injectent leurs enregistreurs par
  `setChildPathPrefixForTests`, exporté seulement par `@veyra/video/testing` (pas par
  `@veyra/video`) et qui lève une erreur hors Vitest ;
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

Contrôle avant lancement (T127-sec N7) : l'exécuteur refuse de démarrer
ffmpeg/ffprobe (directement ou sous `prlimit`) si une entrée `-i` qui n'est pas un
graphe lavfi (`-f lavfi` juste avant ce `-i`) n'a pas, parmi ses options d'entrée,
`-protocol_whitelist file` et une `-format_whitelist` dont chaque démultiplexeur
appartient à `MEDIA_FORMATS` ou `IMAGE_FORMATS` (donc ni `hls`, ni `concat`, ni
`lavfi`) ; ffprobe (entrée positionnelle unique) doit porter les deux options, sauf
graphe `-f lavfi`. Toute valeur de `-protocol_whitelist` autre qu'exactement `file`
(`file,pipe`, `file,http`…) est refusée. Aucun appelant du runtime n'a dû changer
(les chemins audio reçoivent toujours `MEDIA_FORMATS` de l'exécuteur).

Limites : `runProcess` est une primitive de bas niveau : ses appelants ne doivent
jamais lui passer d'argv contrôlé par le modèle ou l'utilisateur (un graphe
`-f lavfi -i movie=…`, ou un filtre `movie=`/`amovie=` dans `-vf`/`-filter_complex`,
lit encore un fichier : le contrôle ne porte que sur les entrées `-i`) ; une
commande donnée en chemin absolu est lancée telle quelle (pas de liste blanche de
binaires). `MEDIA_FORMATS`
est codé en dur : ajouter un format à `config/audio.yaml` exige de le reporter (test
de cohérence dans `process-policy.test.ts`).
Vérifications : `packages/video/src/process.test.ts`,
`packages/video/src/process-policy.test.ts` (refus HLS/ffconcat/liens, PATH fixe,
limites par nom de base, refus avant lancement des `-i` sans listes et des
protocoles autres que `file`, faux `ffmpeg` à côté d'un node inscriptible jamais
exécuté, risques résiduels épinglés `RESIDUAL`),
`apps/studio/src/lib/server/jobs/process-env.test.ts` (ffmpeg/ffprobe réels derrière
un enregistreur placé en tête du PATH enfant par le crochet de test),
`packages/hyperframes-adapter/src/engine-sandbox.test.ts` (bwrap réel : réseau,
socket sous `/run/user/$UID` invisible, fichier et socket créés sous le vrai
`$HOME`, `~/.ssh`, `~/.claude`, `~/.config` invisibles, délai mural sous
`--new-session`).

## Serveur Studio

- Accès (T136, T136b ; `apps/studio/src/lib/server/access.ts`, appliqué par le plugin
  Vite `accessGuard` de `vite.config.ts` **et** par le hook `src/hooks.server.ts`) :
  serveurs de développement et de prévisualisation sur `127.0.0.1`. La même politique
  passe avant les middlewares de Vite qui servent des contenus (sources `/src`, `/@fs`,
  `/@id`, `/@vite/client`, dépendances pré-groupées, fichiers statiques, bundle) et coupe
  la websocket HMR ; seuls quatre middlewares internes de Vite la précèdent en
  développement (rejet des requêtes invalides, CORS des préflights `OPTIONS`, contrôle
  d'hôte, mesure du temps), sans servir de contenu. Requêtes en forme absolue refusées
  (400) ; corps du formulaire de connexion non authentifié limité à 4 Kio
  (`Content-Length` obligatoire, sinon 413). Règles : client non local refusé (403), même avec `--host` ; client
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

## Facturation de l'API Anthropic (D022)

- Clé : lue une seule fois depuis `$app/env/private` et passée explicitement au client
  SDK (`new Anthropic({ apiKey, maxRetries: 0 })`) ; le SDK ne lit donc pas
  `process.env` pour l'identifiant. `/settings` n'expose que sa présence, depuis la
  même source. Jamais dans un log, un message ou une page.
- Aucun appel facturable sans enveloppe : 0 par défaut ; réservation du pire cas avant
  l'appel, transactionnelle (`reserveBudget`) ; aucun nouvel essai automatique du SDK.
- Erreurs du SDK (limite de débit, clé refusée, connexion, délai, annulation, autre
  statut) traduites en messages sans contenu de requête ni de réponse.
- Limite : coût calculé depuis la grille tarifaire locale, à revérifier sur la page
  Pricing d'Anthropic ; l'enveloppe ne protège pas contre une grille fausse.

## Vérifications et limites

Tests rapides : tentatives de traversée/symlink, originaux exclusifs, HTML/CSS/JS
injectés refusés ou échappés, argv du sandbox, refus sans bwrap, limites de sortie,
timeout réel et persistance des erreurs. Le rendu réel sous bwrap réseau coupé a
été exécuté avec succès le 2026-10-28 (test lent et parcours E2E).
Aucun audit de vulnérabilités en ligne n’a été exécuté. Les licences HyperFrames et
GSAP restent à vérifier pour redistribution (ARCHITECTURE).
Authentification, rétention des médias et procédure d’incident restent à définir.
