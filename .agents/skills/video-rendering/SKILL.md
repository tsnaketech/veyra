---
name: video-rendering
description: Use when touching HyperFrames composition, the bwrap sandbox, the render job runner or render progress (packages/hyperframes-adapter, apps/studio/src/lib/server/jobs).
---

# Rendu HyperFrames

- HyperFrames 0.8.209 n'expose pas d'API de rendu : `HyperFramesEngine` appelle le CLI (`lint`, puis `render`) via `spawn` sans shell, dans `bwrap --unshare-net`, sous `prlimit`.
- Sans bwrap, le rendu est refusé (`SandboxUnavailableError`). Ne pas ajouter de repli non isolé sans `allowUnsandboxed` explicite dans `config/engines.json`.
- GSAP est copié localement dans chaque composition : aucun accès réseau au rendu.
- Lint HyperFrames : ne jamais animer `visibility`/`autoAlpha`/`display` d'un élément `.clip` ; les clips restent des éléments plats.
- Les erreurs du CLI arrivent souvent sur stdout : `ProcessError.stderrTail` contient la fin de stdout + stderr.
- Une révision dont le rendu échoue passe à `failed` ; on ne la réutilise pas.

Prérequis machine : `hyperframes browser ensure` (Chrome headless dans `~/.cache/hyperframes`).
Vérifier : `pnpm --filter @veyra/hyperframes-adapter test:slow` (rendu réel 6 s).
Référence : [VIDEO-PIPELINE](../../../docs/video/VIDEO-PIPELINE.md).
