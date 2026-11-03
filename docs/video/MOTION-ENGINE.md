# Motion Engine (v0.2, première itération)

Registre de composants animés validés (`packages/motion`) que l'IA compose dans le
storyboard, rendus par HyperFrames. Décision : D017.

## Registre

| Id | Nom | Durée (ms) | Capacités | Texte principal |
|---|---|---|---|---|
| `animated-title` | AnimatedTitle | 2000–8000 (4000) | headline, kinetic-text | `title` |
| `feature-cards` | FeatureCards | 3000–10000 (5000) | list, stagger | `heading` |
| `product-mockup` | ProductMockup | 3000–10000 (4000) | product-ui, chart, device-frame | `screenTitle` |
| `metrics-counter` | MetricsCounter | 3000–8000 (4000) | numbers, counter | `heading` |
| `call-to-action` | CallToAction | 2000–6000 (3000) | call-to-action, pulse | `headline` |

Chaque composant déclare : identifiant stable et `version` (1), schéma Zod strict des
paramètres (longueurs, nombres d'éléments), style (`accent` violet/bleu/cyan de la
marque, `align`, options propres), durée min/max/défaut, capacités, champ de texte
principal, exemple. La liste lisible (paramètres, style, aperçu) est sur la page
**Composants** du Studio.

## Ce qu'un composant produit

`build(params, style, ctx)` renvoie du **HTML échappé** et des **animations sous forme
de données** : `tweens` (sélecteur `#scene-N .classe`, propriétés numériques bornées,
easing d'une liste fermée, `stagger`, `repeat ≤ 3`) et `counters` (valeur de départ et
d'arrivée, décimales, préfixe/suffixe). Ces données sont revalidées par Zod, puis le
compositeur fixe (`compose.ts`) écrit `tl.fromTo(...)` et `veyraCounter(...)` avec un
JSON neutralisé (`<`, `>`, U+2028/9 échappés). Aucun paramètre, aucun modèle ne peut
fournir de JavaScript, de CSS ou de HTML brut. Les nombres des compteurs sont formatés
en français (`Intl.NumberFormat("fr-FR")`).

Mise en page : zone sûre `inset: 7% 8%`, tailles dérivées de la hauteur, aucun texte
sous 2,6 % de la hauteur (28 px à 1080p, seuil `text_below_floor` d'HyperFrames).
Le texte reste blanc sur fond sombre : la couleur d'accent ne porte que des traits,
pastilles ou contours, car le violet et le bleu restent sous 4,5:1 sur le dégradé
(T104). Exemple : numéros de FeatureCards en blanc à 2,8 % (30 px à 1080p), précédés
d'un trait d'accent (`::before`).
Seule exception : le nom d'application de ProductMockup (`.app-name`, `<b>`,
graisse calculée 900 dans Chromium), à 2,6 % de la hauteur (28 px en paysage et
en carré, 50 px en portrait), sur le fond uni `#12152a` de la navigation (masquée
avec `device: phone`). C'est un grand texte WCAG (gras ≥ 18,66 px), seuil 3:1.
Contraste théorique : 3,16:1 (violet), 3,48:1 (bleu), 7,42:1 (cyan) ; mesuré sur
rendu réel brouillon (T104, 2026-11-03) : 3,02–3,12 (violet), 3,29–3,42 (bleu),
6,97–7,27 (cyan). Marge très faible en violet : ne pas réduire sa taille, sa
graisse ni assombrir l'accent ; le passer en blanc si le seuil devient 4,5:1.
Chaque scène sauf la dernière sort en fondu (0,4 s max) ; HyperFrames gère la
visibilité des clips.

État initial des entrées (T095) : les `tl.fromTo(...)` des composants utilisent
`immediateRender: true`. L'état « from » est donc appliqué dès la construction de la
timeline, et un élément à entrée décalée (`at > 0` ou `stagger`) reste caché jusqu'au
début de son tween, quel que soit l'ordre des positions demandées (rendu séquentiel,
saut, retour à 0). Règle à conserver : un composant n'anime jamais deux fois la même
propriété d'un même élément en entrée. Sinon, le second `fromTo` écraserait l'état
final du premier ; la sortie, sur `.stage`, garde `immediateRender: false`.
Vérification : `entry-state.slow.test.ts` (images du MP4 et `hyperframes snapshot --at`
dans le désordre).

## Sous-titres (calque)

`compose(storyboard, format, style, captions?)` accepte en 4e argument
`{ track, cues, rate }` : la `CaptionTrack`, la table `quantizeCues` et la cadence
rationnelle de la vidéo (T113). Sans cet argument, la composition est identique octet
pour octet (empreinte vérifiée dans `compose.test.ts`).

- **Une seule source de temps** : la table quantifiée, aussi utilisée par SRT/WebVTT.
  `data-start = startFrame × den / num` et `data-duration = (endFrame − startFrame) ×
  den / num`, en secondes, calculés depuis les frames et jamais depuis les ms
  arrondies. Un cue est visible sur [startFrame, endFrame), une frame à la fois.
- **Calque** : un clip `.clip.cue` par cue, sur la piste `scenes.length` (au-dessus de
  toutes les scènes, `z-index` 10) ; une ligne de `cue.lines` par `.cue-line`, un
  `<span class="w wN">` par mot ; texte échappé. Aucune CSS libre : police (liste
  fermée → familles CSS), taille (% de la hauteur, ≥ 2,6), couleurs, fond
  (`none`/`band`/`box` + opacité), contour (ombre de la couleur de fond) et couleur de
  surlignage viennent de `captionStyleSchema`. Les lignes ne passent pas à la ligne
  (`nowrap`) : la hauteur reste celle de la géométrie.
- **Géométrie par construction** : `captionBandRect(style, format, lignes)` renvoie
  `{x, y, width, height}` en px de composition, et la CSS utilise les mêmes nombres.
  `band` : bande pleine largeur ; `box` : colonne en retrait de 5 % de la largeur de
  chaque côté ; `none` : même colonne, sans fond (pas de zone de contraste fiable).
  Hauteur = lignes × interligne + marges internes ; `y` suit la position et
  `safeMarginPct`. Le QA (T120) mesure le contraste dans cette zone.
- **Animations** (données, compositeur fixe) : `none` ; `fade` et `pop` animent
  `.cue-text` (opacité, échelle) avec `immediateRender: true`, pas le fond, qui est
  donc présent dès `startFrame` ; `word-highlight` et `karaoke` changent la couleur de
  chaque mot à sa frame (même règle d'accrochage que les cues :
  `firstFrameAtOrAfter`). Le changement se termine un quart de frame avant la frame
  visée, qui montre donc le nouvel état. Un mot qui commence avec le cue est allumé
  par la classe `on`, sans tween. `karaoke` garde les mots allumés ;
  `word-highlight` éteint le mot précédent par un tween `immediateRender: false`.
- **Règle T095** : au plus une entrée par propriété et par élément ; toute extinction
  utilise `immediateRender: false`. L'état visible est correct quel que soit l'ordre
  des positions demandées.

Vérification : `captions.slow.test.ts` (rendus réels à 24, 30 et 60 i/s, bande
présente exactement sur [startFrame, endFrame) sur chaque frame du MP4 et sur
`hyperframes snapshot --at` dans le désordre, mots allumés à leur frame, `check` sans
erreur). Limites : un mot ou une ligne plus large que la colonne déborde (signalé par
la mise en page de `check`) ; les polices `system-sans` et `serif` dépendent des
polices installées dans le Chrome de rendu ; la cadence passée doit être celle du
rendu (`-f`), qui n'accepte que des entiers.

## Storyboard

Une scène porte soit un texte (rendu historique, inchangé), soit
`component: { id, version, params, style }`. Son `text` est le texte principal du
composant (étiquette, recherche de scène, QA). Le brouillon d'un modèle
(`storyboardDraftSchema`) accepte `component` par union discriminée sur l'id ;
`toStoryboard` normalise et vérifie la durée. Les composants sont copiés tels quels
d'une révision à l'autre.

Corrections : `patch.text` remplace le texte principal du composant ; `patch.params`
fusionne des paramètres puis revalide tout le composant (impossible de changer de
composant ou d'ajouter un champ). Une durée hors limites est refusée.

## Prévisualisation

- `previewStoryboard(id)` : une scène avec l'exemple du composant.
- `pnpm motion:previews [--out DIR] [--demo FICHIER.mp4]` : rendu HyperFrames réel de
  chaque aperçu sous bwrap, image à 70 % de la durée, résultat de `check` et temps de
  rendu dans `apps/studio/static/motion-previews/index.json` ; `--demo` rend la
  composition de démonstration (5 composants, 20 s, `motionDemoStoryboard`).

## Qualité

`hyperframes check --json` tourne avant chaque rendu (bac à sable) et devient des
contrôles QA : mise en page, contraste WCAG AA, exécution, animations et transitions
(conseils), plus la performance de rendu ([QUALITY-STANDARDS](QUALITY-STANDARDS.md)).
Les régressions et corrections restent vérifiées par le QA comparatif et l'expertise.

## Ajouter un composant

1. `defineComponent` dans `packages/motion/src/components.ts` : schéma strict, bornes
   de texte, sélecteurs sous `ctx.sceneId`, classes CSS dans `motionCss`.
2. L'ajouter à `motionComponents` (l'id ne change plus jamais ; un changement
   incompatible crée une `version` 2).
3. `pnpm --filter @veyra/motion test`, puis `pnpm motion:previews` : l'aperçu doit
   passer `check` sans erreur avant d'être déclaré fonctionnel.

## Limites connues

- Avertissement `nested_structure_needs_subcomposition` : HyperFrames recommande une
  sous-composition par scène pour sa propre timeline ; sans effet sur le rendu, non fait.
- Pas d'image utilisateur dans ProductMockup (maquette dessinée en CSS).
- Le simulateur compose avec des paramètres d'exemple (fonctionnalités, chiffres) que
  l'utilisateur doit remplacer ; le Studio le signale.
