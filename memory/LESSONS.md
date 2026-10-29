# Leçons vérifiables

- Les FK SQLite doivent être activées sur chaque connexion ; les tests appliquent
  les migrations réelles (`repo.test.ts`).
- Une scène conservée doit être mise à jour sans supprimer sa ligne, pour
  préserver les retours existants.
- 2026-10-28 — Le migrateur Drizzle exécute chaque fichier en transaction :
  `PRAGMA foreign_keys=OFF` y est sans effet et `defer_foreign_keys` ne suffit pas.
  Une reconstruction de table référencée (changement de CHECK) échoue (D008).
- 2026-10-28 — HyperFrames lint refuse toute animation de `visibility`/`autoAlpha`
  sur un `.clip` et écrit ses erreurs sur stdout, pas stderr.
- 2026-10-28 — Un motif `projects/` non ancré dans `.gitignore` masquait
  `src/routes/projects/` à git **et** à la détection de sources de Tailwind 4
  (classes absentes du CSS). Ancrer les motifs de dossiers de données (`/projects/`).
- 2026-10-28 — SvelteKit 3 : `building` vient de `$app/env` ; alias internes
  `#lib/...` avec extension ; liens internes via `resolve()` (règle ESLint).
- 2026-10-28 — `pnpm preview` lancé par Playwright laissait un Vite orphelin
  sur le port 4173 ; lancer le serveur avec `exec` dans `webServer.command`.
- 2026-10-28 — `pkill -f <motif>` dans une commande qui contient ce motif tue
  son propre shell.
- 2026-10-28 — drizzle-kit génère pour une reconstruction de table un
  `INSERT … SELECT` qui lit les **nouvelles** colonnes dans l'ancienne table :
  le corriger à la main (colonnes existantes, mappage des valeurs) et le tester
  sur une base créée avec les seules migrations antérieures (`migration.test.ts`).
- 2026-10-28 — Index de frame : depuis un temps quelconque, prendre le plancher ;
  depuis un horodatage de présentation (`requestVideoFrameCallback.mediaTime`),
  arrondir (PTS tronqués à la µs à 29,97 i/s). Chercher le milieu de la frame.
- 2026-10-28 — Un module qui réexporte un autre module qui l'importe (cycle
  `index.ts` ↔ `assisted.ts`) voit ses constantes `undefined` à l'évaluation :
  y accéder paresseusement.
- 2026-10-28 — Une couleur de test aléatoire peut être assez sombre pour
  `blackdetect` (pix_th 0,10) et déclencher l'auto-correction : forcer des teintes claires.
- 2026-10-28 — PSNR et diff de storyboard prouvent un changement, pas son sens :
  sur rendu réel, une entrée accélérée au lieu de ralentie et une correction
  partielle ressortaient « appliquées ». Seul un jugement sur images (ou humain) le voit.
- 2026-10-28 — Après `prettier --write`, un `str.replace` Python sur une ligne
  reformatée échoue en silence : asserter la présence du motif avant de remplacer.
- 2026-10-28 — Un benchmark dont les attendus et l'évaluateur simulé sont écrits par
  le même agent sur les mêmes formulations donne un score flatteur sans valeur :
  faire valider les attendus par un humain et mesurer de vrais experts.
- 2026-10-29 — `hyperframes check` trouve de vrais défauts que les tests unitaires ne
  voient pas (contraste du surtitre, textes < 28 px) : ne déclarer un composant
  fonctionnel qu'après un aperçu réel passé par `check`.
- 2026-10-29 — Remplacer une règle CSS contenant `${px(…)}` avec `[^}]*` coupe à la
  première accolade du gabarit : éditer la ligne entière.
- 2026-10-29 — L'outil Write convertit les échappements `\u2028` d'un littéral regex en
  vrais caractères : écrire ce type de ligne en ASCII via un script.
