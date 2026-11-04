# CLAUDE.md

@AGENTS.md

## Spécifique à Claude Code

Les consignes communes sont dans `AGENTS.md` ; ne pas les recopier ici.

- Skills du projet : `.claude/skills` est un lien vers `.agents/skills/`
  (prompt-to-video, video-rendering, video-review, video-quality-assurance,
  veyra-assisted-task). Composants animés : docs/video/MOTION-ENGINE.md.
  Les charger avant de modifier le domaine correspondant.
- Sous-agents de développement : `.claude/agents` est un lien vers `.agents/agents/`
  (motion, pipeline vidéo, audio et voix, contrats, tests, sécurité, revue
  indépendante, recherche). Ce ne sont pas des agents métier Veyra :
  [AGENT-ARCHITECTURE](docs/ai/AGENT-ARCHITECTURE.md). Contrôle des définitions :
  `packages/config/src/agents.test.ts`.
- Skills externes (GSAP pour la 2D, Three.js pour la 3D seulement, playwright-cli,
  ffmpeg-skill, remotion-best-practices) : à la demande, un seul à la fois, après
  le skill Veyra du domaine ; jamais dans le pipeline. Matrice et règles :
  [SKILLS-STRATEGY](docs/ai/SKILLS-STRATEGY.md).
- Vérifications : `pnpm test`, `pnpm check`, `pnpm lint` ; rendu réel et
  parcours complet : voir [TESTING](docs/TESTING.md) (Chrome headless requis).
- Lancer le Studio en local avec `VEYRA_AI_PROVIDER=fake` pour les tests ; ne
  jamais afficher ni journaliser `ANTHROPIC_API_KEY`.
- `/veyra-assisted-task <dossier>` traite une demande `claude-subscribe` exportée
  par le Studio : n'écrire que `result.json`, ne rien exécuter (D010).
