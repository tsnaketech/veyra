# Compositions originales : stratégie en deux niveaux

Statut : **stratégie proposée le 2026-11-04**, non implémentée (T131 pour le niveau 1).
Décision associée : D021 (proposée). Le but est de **ne pas limiter la liberté créative**
du Director tout en gardant une exécution reproductible et sûre.

## Niveau 1 — langage de composition déclaratif (DSL)

Un vocabulaire de **primitives composables**, pas une bibliothèque de modèles : le
Director décrit une scène originale avec des éléments, des styles et des animations ;
le compositeur fixe (`compose()`) la compile en HTML/CSS et en tweens GSAP de données.

| Famille | Contenu proposé |
|---|---|
| Éléments | texte (découpage en mots/lettres), forme (rect, cercle, ligne, polygone, chemin SVG borné), image et vidéo du projet (asset), groupe/calque, masque |
| Mise en page | positions et tailles en % du cadre, ancrages, grille/flex simples, profondeur (z), zones sûres |
| Style | couleurs (hex, dégradés linéaires/radiaux), polices d'une liste locale, ombres, contours, flou, opacité, modes de fusion d'une liste, transformations CSS 3D (perspective, rotations) |
| Animation | images-clés sur des propriétés en liste blanche (transform, opacity, couleur, clip-path, filtre, stroke-dashoffset, letter-spacing), courbes (liste + bezier borné), décalages (stagger), répétitions bornées, chemins de mouvement |
| Transitions entre scènes | fondu, volet, poussée, zoom, masque, flou — paramétrées |
| Temps | relatif à la scène, quantifié sur les frames (même règle que les sous-titres) |

Garanties du compilateur (pas de la consigne du modèle) : schéma Zod strict et bornes
(nombre d'éléments, de tweens, taille de texte, durée) ; règle T095 imposée (une seule
entrée par propriété et par élément, sorties en `immediateRender: false`) ; texte
échappé ; aucune URL externe ; sortie déterministe (aucun aléa non semé) ;
`hyperframes check` sans erreur ; contrôles T104 (flashs, contraste) appliqués.

Les cinq composants actuels deviennent des **macros** qui se déploient en DSL : ils
restent disponibles, ils ne bornent plus la création. Le DSL reste un **langage**, pas
un catalogue : on étend ses primitives quand une création l'exige, avec tests de rendu
réel, jamais en ajoutant des « gabarits » de scènes entières.

## Niveau 2 — code généré (HTML/CSS/GSAP, Three.js)

Pour ce que le DSL ne sait pas exprimer. **Refusé tant que ces conditions ne sont pas
toutes remplies** (TOOL-REGISTRY § 5, audit de sécurité du 2026-11-03) :

1. Sandbox durcie : plus de `--ro-bind / /` ; montages minimaux (runtime Node,
   Chrome, polices, bibliothèques épinglées, composition en lecture seule), HOME
   factice, `--unshare-all --new-session --clearenv`, sortie dans un dossier vide,
   limites CPU, mémoire, processus, temps.
2. Analyse statique avant écriture : liste blanche de balises/attributs, aucune
   requête réseau (`fetch`, `XMLHttpRequest`, `WebSocket`, `import()`, `<link>`
   externe…), ni `eval`/`new Function`, ni `iframe`/`object` ; bibliothèques locales
   épinglées par empreinte (GSAP ; Three.js seulement après le POC T103).
3. CSP injectée par le compositeur (`default-src 'none'; connect-src 'none'`…).
4. Déterminisme : horloge et aléa fournis par le compositeur (graine), timeline
   HyperFrames seule source de temps ; rendu vérifié par sauts (`snapshot --at` dans le
   désordre) comme pour T095.
5. `check`/`lint` bloquants, contrôles T104 bloquants.
6. Validation humaine du **code** (diff lisible) et du rendu avant toute réutilisation ;
   pas d'auto-correction qui réécrit le code sans nouvelle validation.
7. Provenance : modèle, consigne, hash du code, versions, résultats des contrôles,
   décision humaine, persistés avec la révision ; aucune frame envoyée à un service
   externe sans autorisation.

Three.js : dans ce niveau uniquement, après le POC T103 (rendu WebGL sous bwrap,
`hf-seek`, déterminisme) ; jamais imposé, choisi par le Director quand la 3D sert la
création.

## Ordre

T131 (POC DSL : une scène originale hors des 5 composants, frame exact, `check` sans
erreur, rendue sous bwrap) → extension des primitives selon les besoins réels →
durcissement de la sandbox → décision dédiée pour le niveau 2.
