# CLAUDE.md

@AGENTS.md

## Spécifique à Claude Code

Les consignes communes sont dans `AGENTS.md` ; ne pas les recopier ici.

- Skills du projet : `.claude/skills` est un lien vers `.agents/skills/`
  (prompt-to-video, video-rendering, video-review, video-quality-assurance,
  veyra-assisted-task). Composants animés : docs/video/MOTION-ENGINE.md.
  Les charger avant de modifier le domaine correspondant.
- Vérifications : `pnpm test`, `pnpm check`, `pnpm lint` ; rendu réel et
  parcours complet : voir [TESTING](docs/TESTING.md) (Chrome headless requis).
- Lancer le Studio en local avec `VEYRA_AI_PROVIDER=fake` pour les tests ; ne
  jamais afficher ni journaliser `ANTHROPIC_API_KEY`.
- `/veyra-assisted-task <dossier>` traite une demande `claude-subscribe` exportée
  par le Studio : n'écrire que `result.json`, ne rien exécuter (D010).
