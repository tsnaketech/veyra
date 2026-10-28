# Contexte

2026-10-28 — MVP v0.1 de Veyra livré, puis étendu le même jour (non commité) :
studio vidéo conversationnel (SvelteKit 3 / Svelte 5), rendu HyperFrames 0.8.209
réel sous bwrap, QA ffprobe + revue qualitative + QA comparatif avant/après + expertise QA
consultative par intention (D015),
annotations par frame exacte, lots de corrections idempotents, révisions enfants,
validation humaine, export MP4. Périmètre : [PRD](../docs/PRD.md) (R1–R15) ;
architecture : [ARCHITECTURE](../docs/ARCHITECTURE.md) ; choix : D001–D015 dans
[DECISIONS](../docs/DECISIONS.md).

Fournisseurs IA (D010, D011) : `fake` (tests), `anthropic-api` (clé, non vérifié),
`claude-subscribe` en **mode assisté** choisi par l'utilisateur : Veyra exporte,
l'utilisateur traite avec sa session Claude Code (`/veyra-assisted-task`), Veyra
importe. Aucun basculement automatique.
