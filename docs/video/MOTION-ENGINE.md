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
