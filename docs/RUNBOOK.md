# Exécution locale

Prérequis vérifiés le 2026-10-28 : Node 24.19, pnpm 12.6.0, ffmpeg/ffprobe 5.1.9,
bwrap et prlimit (util-linux), outils de compilation pour better-sqlite3.

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
