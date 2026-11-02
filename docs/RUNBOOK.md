# Exécution locale

Prérequis vérifiés le 2026-10-28 : Node 24.19, pnpm 12.6.0, ffmpeg/ffprobe 5.1.9,
bwrap et prlimit (util-linux), outils de compilation pour better-sqlite3.
Le `ffmpeg` trouvé en premier dans le `PATH` doit fournir libx264 et l'encodeur PNG
(`ffmpeg -encoders | grep -E "libx264|png"`). Le 2026-11-02, un FFmpeg 9.0.2 compilé
sans eux dans `/usr/local/bin` a fait échouer le rendu réel et les tests : voir
[SKILLS-STRATEGY § 2](ai/SKILLS-STRATEGY.md#2-blocage-ffmpeg-constaté-à-traiter-en-premier).

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
| `VEYRA_AI_PROVIDER` | Optionnel, **verrouille** le fournisseur : `fake` (simulateur de test étiqueté), `anthropic-api`, `claude-subscribe`. Absent : choix dans `/settings` |
| `ANTHROPIC_API_KEY` | Clé du seul fournisseur `anthropic-api` (jamais versionnée, jamais affichée) |
| `VEYRA_PROJECTS_ROOT` | Optionnel : racine des médias (défaut `projects/` du dépôt) |
| `VEYRA_CONFIG_DIR` | Optionnel : répertoire `config/` absolu |

Sans `VEYRA_AI_PROVIDER` ni choix enregistré, le Studio démarre avec « IA non
configurée ». Une clé seule n'active plus l'API : choisir `anthropic-api` (D011).

### Utiliser l'abonnement Claude (`claude-subscribe`, mode assisté)

1. Installer Claude Code et s'y connecter avec son compte Claude : `claude auth login`.
   Vérifier avec `/status` que l'abonnement est utilisé ; retirer `ANTHROPIC_API_KEY`
   du terminal de Claude Code, sinon l'API serait facturée à la place.
2. Démarrer le Studio sans `VEYRA_AI_PROVIDER` (ou avec `claude-subscribe`), ouvrir
   `/settings`, choisir `claude-subscribe` ; « Vérifier la disponibilité » doit
   afficher « Disponible ».
3. Dans le Studio, envoyer un prompt ou un lot : un dossier `…/ai-tasks/tsk_…` est
   indiqué. Dans Claude Code, à la racine du dépôt : `/veyra-assisted-task <dossier>`.
4. Revenir au Studio : « Importer le résultat ». Le plan importé attend votre décision.

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

## Démarrage

```sh
pnpm dev                                        # Studio en développement (Vite, port 5173)
pnpm --filter studio build && pnpm --filter studio preview   # build puis serveur local (port 4173)
```

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
