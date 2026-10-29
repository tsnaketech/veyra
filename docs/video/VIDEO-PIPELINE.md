# Pipeline vidéo

## Flux implémenté

1. Le singleton serveur `jobs/index.ts` expose `renderJobRunner.enqueue(jobId)`.
   Le job doit exister en DB à l’état queued et sa révision doit être draft.
   Une file de promesses limite la concurrence à un job dans ce processus.
2. Le runner charge app, engines, style-guide et quality via ConfigLoader ; il
   persiste leur vue masquée et le type de moteur sur le job, puis passe running.
3. ProjectStorage crée `projects/<prj>/revisions/<rev>/{composition,renders}`.
   La racine vient de `config/app.yaml`, résolue depuis la racine du dépôt.
   Le répertoire config est recherché en remontant depuis le répertoire courant ;
   `VEYRA_CONFIG_DIR` permet de le fixer explicitement dans un runtime empaqueté.
4. `compose` valide le storyboard, les dimensions, la palette et les animations.
   Une scène texte devient un clip texte sur dégradé violet/bleu/cyan (texte échappé,
   animations fade/slide-up/scale, 0–1500 ms, easing sur liste fermée). Une scène à
   composant devient un clip produit par le registre `@veyra/motion` : HTML échappé et
   animations en données, écrites par le compositeur fixe ([MOTION-ENGINE](MOTION-ENGINE.md)).
   Le code est entièrement déterministe.
   GSAP 3.14.2 est copié localement depuis node_modules avec son en-tête de licence.
5. HyperFramesEngine appelle le CLI installé via spawn sans shell : `check --json`
   (lint, exécution, mise en page, contraste, mouvement, craft, dans Chrome headless),
   puis lint et render ; le temps de rendu est mesuré. Sandbox encapsule ces appels dans prlimit et bwrap sans réseau.
   Progression : lint → render → encode ; pourcentages CLI utilisés si disponibles.
6. Le MP4 porte l’ID du job et ne remplace pas un fichier existant. La révision
   passe qa. ffprobe lit durée, codec, dimensions, fps, audio et taille ; ffmpeg
   blackdetect relève les segments noirs avec leurs temps.
7. Contrôles déterministes persistés : durée, résolution, fps, h264, fichier non
   vide, absence de segments noirs, plus les groupes issus de `check` et la
   performance de rendu. Le rapport expose l’union des
   modes des constats. La révision passe awaiting_approval, le job succeeded.
   Un contrôle QA négatif reste visible et ne vaut jamais approbation.

Les erreurs de processus conservent les 8192 derniers caractères de stderr ; le
runner persiste également le message, l’étape atteinte et la progression. Le
champ stage conserve l’étape atteinte en cas d’échec ; le statut du job devient failed.
`FakeEngine` est étiqueté fake-test-only, écrit un faux fichier clairement marqué
et nécessite des métadonnées injectées. Ses constats sont simulated.

## API vidéo

- `validate(dir)` : lint et validate HyperFrames, résultat validé par Zod.
- `render(dir, options, onProgress)` : MP4, identifiant du moteur et stderrTail.
- `preview(dir)` : rendu draft sous `renders/preview.mp4`, réutilisé s’il existe
  et reste inspectable. Aucun serveur persistant ; invalider ce fichier si une
  composition est modifiée avant sa prochaine prévisualisation.
- `inspect(file)` / `probe(file)` : métadonnées validées et détection des noirs.
- `extractFrames(file, timestampsMs)` : PNG dans un dossier adjacent unique,
  temps validés dans la durée de la vidéo, au plus 60 images par appel.

Les scènes sont exprimées en millisecondes dans les contrats ; le générateur
convertit leurs temps en secondes pour HyperFrames. Durée MVP maximale 60 s.
Le framerate effectif provient d’engines.json (30 par défaut). Les polices sont
locales au système ; aucune police distante n’est téléchargée. Inter peut être
remplacée par le fallback système si elle n’est pas installée.

## Commandes et preuve

Avec l’environnement pnpm hors ligne décrit dans RUNBOOK :

```sh
pnpm -r test
pnpm --filter @veyra/hyperframes-adapter test:slow
```

Le test lent compose trois scènes / six secondes, appelle le vrai moteur sous
bwrap puis vérifie environ 6 s, 1920×1080, h264, 30 fps et aucun segment noir.
Il est exclu de `test`. Exécuté le 2026-10-28 hors du bac à sable Codex :
**1 réussi, 0 échec** (rendu réel ≈ 5,4 s). Le parcours Studio complet avec rendu
réel est couvert par `apps/studio/tests/mvp.e2e.ts` (voir TESTING).

Contrainte HyperFrames rencontrée : la règle de lint `gsap_animates_clip_element`
interdit d'animer `visibility`/`autoAlpha` d'un élément `.clip` (le moteur gère
la visibilité des clips). `compose` rend donc chaque scène comme un clip plat
(`<p class="clip">`) et n'anime que l'opacité et les transformations.

Forme de la commande construite par le moteur (arguments séparés, sans shell) :
`node <hyperframes/bin/hyperframes.mjs> render . -o <MP4> -q draft --quiet -f 30`,
précédée de lint et encapsulée dans le sandbox décrit dans SECURITY.
Les commandes CLI validate, inspect, snapshot et preview fournies dans le cadrage
n’ont pas toutes été exécutées ici. L’inspection d’un MP4 par notre API utilise
ffprobe, car l’inspection CLI HyperFrames vise une composition.

## Revue qualitative

Après les contrôles déterministes, le runner appelle un `Reviewer` optionnel :
une image est extraite au milieu de chaque scène et transmise au fournisseur IA
(`AiProvider.reviewFrames`). Ses constats rejoignent le même rapport avec leur
propre mode (`multimodal`, `text-only` ou `simulated`). Voir QUALITY-STANDARDS.

## Limites actuelles

Pas de worker indépendant (D006). `resumeQueued()` reprend explicitement les jobs
encore queued ; les jobs running abandonnés après crash nécessitent une
réconciliation opérateur. Pas d'annulation exposée. Une instance de Studio seulement.
Une révision dont le rendu échoue passe à `failed` ; un nouvel envoi crée une
nouvelle révision.
