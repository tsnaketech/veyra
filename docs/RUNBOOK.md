# Exécution locale

Prérequis vérifiés le 2026-11-02 : Node 24.19, pnpm 12.6.0, ffmpeg/ffprobe 9.0.2
(`/usr/local/bin`, compilé localement : [install_ffmpeg](install_ffmpeg.md)), bwrap et
prlimit (util-linux), outils de compilation pour better-sqlite3.
Le `ffmpeg` trouvé en premier dans le `PATH` doit fournir libx264 et l'encodeur PNG
(`ffmpeg -encoders | grep -E "libx264|png"`), sinon le rendu réel et les tests échouent.
ffmpeg-skill exige en plus FFmpeg ≥ 6.1 : le 5.1.9 de Debian ne lui suffit pas.

## Installation

```sh
pnpm install                                   # depuis la racine, lockfile unique
pnpm --filter @veyra/hyperframes-adapter exec hyperframes browser ensure   # Chrome headless (~/.cache/hyperframes)
cp apps/studio/.env.example apps/studio/.env   # puis ajuster
```

Les scripts natifs de better-sqlite3 et esbuild sont autorisés dans
`pnpm-workspace.yaml`. Le rendu se fait réseau coupé : Chrome et les dépendances
doivent être installés avant tout rendu.

Historique : le 2026-10-27, l'agent Codex a dû installer hors ligne
(`--offline --trust-lockfile`, store copié) faute de DNS ; la vérification en ligne
des politiques pnpm a été refaite par un `pnpm install` normal le 2026-10-28.

## Configuration

`apps/studio/.env` (non versionné) :

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Fichier SQLite (défaut `local.db`, relatif à `apps/studio`) |
| `VEYRA_AI_PROVIDER` | Optionnel, **verrouille** le fournisseur, y compris pour tous les projets : `fake` (simulateur de test étiqueté), `anthropic-api`, `claude-subscribe`, `openai-api`, `codex-chatgpt`. Absent : choix global dans `/settings` (revérifié au démarrage), remplaçable par projet depuis la page projet (D024) |
| `ANTHROPIC_API_KEY` | Clé du seul fournisseur `anthropic-api` (jamais versionnée, jamais affichée) |
| `OPENAI_API_KEY` | Clé du seul fournisseur `openai-api` (jamais versionnée, jamais affichée, jamais transmise à Codex) |
| `VEYRA_CODEX_COMMAND` | Optionnel : chemin **absolu** du binaire Codex (`codex-chatgpt`) ; prioritaire sur `codexChatgpt.command` de `config/models.json` (versionné à `null`) |
| `VEYRA_CODEX_HOME` | Optionnel : chemin **absolu** du `CODEX_HOME` dédié ; sans lui, `codex-chatgpt` est indisponible (« CODEX_HOME dédié non configuré », jamais `~/.codex`) |
| `VEYRA_PROJECTS_ROOT` | Optionnel : racine des médias (défaut `projects/` du dépôt) |
| `VEYRA_CONFIG_DIR` | Optionnel : répertoire `config/` absolu |

Sans `VEYRA_AI_PROVIDER` ni choix enregistré, le Studio démarre avec « IA non
configurée ». Une clé seule n'active plus l'API : choisir `anthropic-api` (D011).

### Autoriser une enveloppe de dépense (`anthropic-api`, D022)

Aucun appel facturable n'est fait sans enveloppe (0 par défaut).

1. Vérifier dans `/settings` le modèle utilisé, son tarif et la date de vérification
   de la grille (`pricing` de `config/models.json`, à comparer à la page Pricing
   d'Anthropic avant usage).
2. Dans la page projet, saisir « Enveloppe autorisée (USD) » avec le prompt ; le
   formulaire indique le pire cas estimé d'un appel storyboard.
3. Le panneau Production affiche autorisé / dépensé / réservé. En cas de « Budget
   insuffisant », saisir une enveloppe plus grande (« Augmenter »), puis
   « Reprendre ». Plans de correction, revue et expertise QA d'une révision sont
   imputés au run qui l'a produite. « Arrêter » annule l'appel en cours (sa
   réservation reste comptée comme dépensée). Après un arrêt brutal du Studio, les
   réservations restantes sont comptées comme dépensées au démarrage suivant (message
   dans la conversation du projet).

### Utiliser l'abonnement Claude (`claude-subscribe`, mode assisté)

1. Installer Claude Code et s'y connecter avec son compte Claude : `claude auth login`.
   Vérifier avec `/status` que l'abonnement est utilisé ; retirer `ANTHROPIC_API_KEY`
   du terminal de Claude Code, sinon l'API serait facturée à la place.
2. Démarrer le Studio sans `VEYRA_AI_PROVIDER` (ou avec `claude-subscribe`), ouvrir
   `/settings`, choisir `claude-subscribe` ; « Vérifier la disponibilité » doit
   afficher « Disponible ».
3. Dans le Studio, envoyer un prompt ou un lot : un dossier `…/ai-tasks/tsk_…` est
   indiqué. Dans Claude Code, à la racine du dépôt : `/veyra-assisted-task <dossier>`.
4. Revenir au Studio : le résultat est importé automatiquement quelques secondes
   après son écriture (la page s'actualise seule). En cas d'erreur affichée sur la
   tâche, corriger `result.json` (réimporté s'il change) ou cliquer sur « Importer
   le résultat ». Si la production a été arrêtée entre-temps, le résultat est
   enregistré sans relance : cliquer sur « Reprendre ». Le plan importé attend
   votre décision.

### Configurer OpenAI (`openai-api`, D023)

1. Créer une clé API sur OpenAI Platform (facturation à l'usage) et la définir dans
   `OPENAI_API_KEY` (même fichier que les variables ci-dessus).
2. Dans `config/models.json`, renseigner `"openai": { "model": "<modèle>" }` et une
   entrée `pricing["<modèle>"]` relevée sur la page de tarifs d'OpenAI (`source`,
   `checkedAt`). Sans tarif, le fournisseur reste indisponible.
3. `/settings` → « Vérifier la disponibilité », choisir `openai-api`. Enveloppe :
   comme pour `anthropic-api` ci-dessus (plafond `maxBudgetUsd`, 20 $ par défaut).
   Aucune image n'est envoyée tant qu'aucune borne de jetons d'image n'est sourcée
   (T140, T145) : la revue qualitative est « non effectuée », le plan de correction
   et l'expertise QA sont faits en texte seul et le signalent.
4. Points d'accès : `baseUrls` de `config/models.json` (HTTPS) ;
   `ANTHROPIC_BASE_URL` et `OPENAI_BASE_URL` sont ignorés.

### Activer Codex avec l'abonnement ChatGPT (`codex-chatgpt`, D023)

Statut contractuel ambigu, accepté par l'utilisateur ; tout est fait par lui.
Version épinglée : **Codex 0.167.0** (npm, provenance SLSA vérifiable ;
[étude § 10.5](research/OPENAI-CODEX-INTEGRATIONS.md)).

1. Installation, hors dépôt, sans sudo :

   ```sh
   mkdir -p /home/user/.local/share/veyra/codex-cli
   npm install --prefix /home/user/.local/share/veyra/codex-cli --ignore-scripts --save-exact @openai/codex@0.167.0
   npm audit signatures --prefix /home/user/.local/share/veyra/codex-cli
   ```

   Binaire : `/home/user/.local/share/veyra/codex-cli/node_modules/.bin/codex`.
2. `CODEX_HOME` dédié, ne contenant que l'authentification (pas d'`AGENTS.md` global
   ni de configuration personnelle) : `mkdir -p -m 700 /home/user/.local/share/veyra/codex-home`.
3. Connexion, lancée par l'utilisateur avec son compte ChatGPT (code à saisir dans un
   navigateur), identifiants dans `auth.json` du `CODEX_HOME` dédié (jamais le
   trousseau) :

   ```sh
   CODEX_HOME=/home/user/.local/share/veyra/codex-home \
     /home/user/.local/share/veyra/codex-cli/node_modules/.bin/codex \
     -c 'cli_auth_credentials_store="file"' login --device-auth
   ```

   Ne pas définir `OPENAI_API_KEY` ni `CODEX_API_KEY` pour Codex. Une connexion par
   clé API n'est pas acceptée (« Connexion ChatGPT non confirmée »). Déconnexion :
   même `CODEX_HOME`, `codex logout`.
4. Chemins propres à la machine, hors dépôt (T148) : dans `apps/studio/.env` (non
   versionné), valeurs de cette machine :
   ```
   VEYRA_CODEX_COMMAND=/home/user/.local/share/veyra/codex-cli/node_modules/.bin/codex
   VEYRA_CODEX_HOME=/home/user/.local/share/veyra/codex-home
   ```
   `config/models.json` garde `codexChatgpt.command` et `codexHome` à `null`
   (`timeoutMs`, 300000 par défaut). Redémarrer le Studio après modification. Le
   fournisseur reste désactivé tant que l'utilisateur ne l'active pas.
5. `/settings` → « Activer Codex », puis « Vérifier la disponibilité » (lance
   seulement `codex --version` et `codex -c cli_auth_credentials_store="file" login
   status` : code 0 et « ChatGPT » sur stderr) et choisir `codex-chatgpt`.
   « Désactiver Codex » le rend de nouveau indisponible.
6. Démonstration réelle (T147), à lancer seulement après la connexion ; consomme le
   quota du plan : `VEYRA_CODEX_REAL=1 VEYRA_CODEX_COMMAND=… VEYRA_CODEX_HOME=… pnpm --filter @veyra/ai exec vitest run src/codex.real.test.ts`
   (chemins de l'étape 4). Sans ces trois variables, ce fichier est ignoré (y compris par `pnpm test`). Il vérifie la
   sonde, un storyboard validé, le refus d'un brief demandant une commande shell et
   l'écriture de `pwned.txt`, l'annulation après 2 s (groupe de processus tué) et
   l'absence de clé API dans l'environnement de Codex ; il affiche la durée de
   chaque appel.
7. Le prompt est passé en argument de `codex exec` : il est visible localement via
   `ps` par les autres utilisateurs de la machine. Ne pas utiliser ce fournisseur sur
   une machine partagée avec des contenus confidentiels.

## Skills externes HyperFrames (après un clone)

Les skills propres à Veyra sont versionnés dans `.agents/skills/` (lien
`.claude/skills`). Les skills HyperFrames (figma, hyperframes, hyperframes-cli,
hyperframes-registry, media-use, remotion-to-hyperframes, slideshow) ne le sont pas :
ils viennent du plugin Claude Code officiel `hyperframes@hyperframes`, figé dans
`.claude/settings.json` sur le tag `v0.8.214` de `heygen-com/hyperframes` (D018).

Réinstallation, à la racine du clone (Claude Code installé ; `git` et accès à github.com) :

```sh
claude plugin marketplace add 'heygen-com/hyperframes#v0.8.214' --scope project --sparse .claude-plugin skills
claude plugin install hyperframes@hyperframes --scope project
```

Sans clé SSH GitHub, préfixer ces commandes par `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`.
Elles sont idempotentes et laissent `.claude/settings.json` inchangé. Ouvrir Claude Code
dans le dossier et accepter la confiance suffit aussi à enregistrer la marketplace,
mais pas en mode non interactif : un `install` seul échoue alors avec `Plugin
"hyperframes" not found in marketplace "hyperframes"`.

Vérification :

```sh
claude plugin list                # hyperframes@hyperframes · Version 0.8.214 · Scope project · enabled
claude plugin marketplace list    # hyperframes · Source: GitHub (heygen-com/hyperframes@v0.8.214)
git -C ~/.claude/plugins/marketplaces/hyperframes rev-parse HEAD
                                  # 4719543e972548a261b8354f0a8dada479ae5d93 (tag v0.8.214)
claude plugin details hyperframes  # Component inventory · Skills (7) figma, hyperframes, hyperframes-cli,
                                  #   hyperframes-registry, media-use, remotion-to-hyperframes, slideshow
```

Dans une session, ils s'appellent `/hyperframes:<nom>`.

Mises à jour : jamais silencieuses. L'auto-update est désactivé par défaut pour cette
marketplace tierce, et `claude plugin marketplace update hyperframes` /
`claude plugin update hyperframes@hyperframes` restent sur le tag. Pour changer de
version : remplacer `v0.8.214` dans les deux commandes ci-dessus, les relancer, vérifier
(`claude plugin list`, `hyperframes check` sur une composition), committer le nouveau
`.claude/settings.json`.

Points d'attention :
- Le CLI de rendu (`hyperframes`, figé dans `packages/hyperframes-adapter/package.json`,
  `pnpm-lock.yaml` et `config/engines.json` → `cliVersion`) et les skills sont tous deux en
  0.8.214. Pour une nouvelle version, changer les quatre endroits ensemble (plus
  l'exemption `minimumReleaseAgeExclude` de `pnpm-workspace.yaml` si la version a moins
  d'un jour), puis relancer tests, `test:slow`, E2E et `pnpm motion:previews`.
- `npx hyperframes skills …` et `npx skills add …` gèrent des copies autonomes non
  figées (branche principale) : ne pas les utiliser pour ce dépôt. Le bac à sable de
  rendu impose `HYPERFRAMES_SKIP_SKILLS=1`, donc le CLI n'en installe jamais.
- Procédure vérifiée sur une configuration Claude Code vierge. Sur une machine où le
  plugin est déjà installé en portée utilisateur depuis la branche principale, la
  marketplace porte le même nom : contrôler ensuite `claude plugin list` (deux
  portées possibles) et le commit de la marketplace ; cas non testé.

## Aperçus et démo du Motion Engine

```sh
pnpm motion:previews                              # aperçus réels → apps/studio/static/motion-previews/
pnpm motion:previews --demo projects/_demo/demo.mp4   # + démo 20 s à 5 composants
```

Rendu HyperFrames réel sous bwrap (Chrome headless requis), ~25 s pour les aperçus.

## Moteurs locaux optionnels (voix, sous-titres)

Aucun moteur n'est requis : sans moteur, la voix importée, la voix simulée et les
sous-titres `scene` fonctionnent. Les moteurs candidats (Piper pour la synthèse)
sont décrits dans `config/voice.yaml` : artefacts, tailles, SHA-256, licences,
attributions. Rien n'est téléchargé automatiquement.

```sh
pnpm voice:doctor                    # état de chaque moteur, hors réseau ; code 0
pnpm voice:install piper             # affiche le plan puis demande « oui »
pnpm voice:install piper --yes       # confirmation non interactive
pnpm voice:install piper --accept-unpinned MODEL_CARD   # accepte un artefact sans empreinte épinglée
```

- Destination : `~/.local/share/veyra/engines/<moteur>` (hors dépôt, refusé dans le
  dépôt), ou `VEYRA_ENGINES_ROOT/<moteur>`.
- Sans confirmation (réponse autre que « oui », entrée fermée), rien n'est écrit.
  Un artefact sans URL épinglée bloque l'installation (code 2) ; un artefact sans
  empreinte est refusé sauf `--accept-unpinned <nom>` : l'empreinte calculée est
  inscrite dans `veyra-engine.lock.json` (confiance au premier usage).
- Chaque fichier est téléchargé dans un fichier temporaire de la racine, vérifié
  (taille, SHA-256), puis renommé ; en cas d'écart il est supprimé.
- Roues Python : `requirements.txt` (avec `--hash`) est généré ; l'environnement est
  créé hors ligne depuis les fichiers vérifiés, étape non exécutée par
  `voice:install` (commandes `uv venv` / `uv pip install --no-index --require-hashes`
  affichées dans le plan).
- Après installation, les moteurs s'exécutent hors ligne, sous bwrap sans réseau
  (`runEngine`, voir [SECURITY](SECURITY.md)).
- État au 2026-11-03 : Piper **non autorisé ni installé** ; son installation est
  bloquée tant que les URL des roues et l'empreinte d'`onnx` ne sont pas relevées.

## Démarrage

```sh
pnpm dev                                        # Studio en développement (Vite, port 5173)
pnpm --filter studio build && pnpm --filter studio preview   # build puis serveur local (port 4173)
```

Accès (T136, T136b) : les serveurs de développement et de prévisualisation n'écoutent
que `127.0.0.1`. Une même politique protège les pages (hook SvelteKit) et tout ce que
Vite sert avant elles (sources, `/@fs`, fichiers statiques, websocket HMR) : tout
client autre que la machine locale est refusé (403), même lancé avec `--host` ; les
écritures inter-sites (CSRF) et les noms d'hôte autres que `127.0.0.1`, `localhost`
ou `[::1]` (DNS rebinding) sont refusés aussi en local. Accès depuis le réseau local,
à éviter et seulement en connaissance de cause (outil mono-utilisateur, pas de
comptes, pas de TLS) :

```sh
export VEYRA_ALLOW_LAN=1
export VEYRA_ACCESS_TOKEN="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
pnpm dev --host <adresse-ipv4-du-lan>        # jamais 0.0.0.0 si une IPv6 publique existe
```

Le client du réseau reçoit un formulaire (401) : le jeton est envoyé en POST et un
cookie `HttpOnly; SameSite=Strict` est posé ; il ne passe jamais dans une URL ni dans
le journal. Sans jeton d'au moins 32 caractères URL-safe, le mode réseau ne sert aucun
client distant (503). Ne jamais journaliser ni partager le jeton ; le changer pour
révoquer l'accès. Préférer un tunnel SSH (`ssh -L 5173:127.0.0.1:5173`). Un relais local
(tunnel inverse, proxy) ferait passer tous ses clients pour la machine locale : n'en
exposer aucun devant le Studio.

Lancer depuis le dépôt : les migrations (`apps/studio/drizzle/`) sont appliquées
au démarrage et `config/` est trouvé en remontant l'arborescence.

## Base de données

```sh
DATABASE_URL=local.db pnpm --filter studio db:generate   # après modification de schema.ts
```

Lire la mise en garde « Migrations » de [PROJECT-SCHEMA](system/PROJECT-SCHEMA.md)
avant tout changement de contrainte CHECK.

## Diagnostic

- Rendu en échec : message et fin de journal (stdout + stderr du CLI) visibles
  dans le Studio et persistés sur le job (`render_jobs.error`, `stderr_tail`).
- `SandboxUnavailableError` : bwrap absent ou espaces de noms refusés ; ne pas
  activer `allowUnsandboxed` pour des contenus non fiables.
- `pnpm --filter @veyra/hyperframes-adapter exec hyperframes doctor` : état de
  Chrome, ffmpeg et de l'environnement HyperFrames.
- Jobs `running` après un arrêt brutal : non repris automatiquement (D006).

L'adaptateur `adapter-auto` ne détecte aucune plateforme : aucun déploiement n'est
défini. Sauvegarde : copier le fichier SQLite et `projects/` ensemble.
