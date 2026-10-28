# Design et expérience utilisateur

## Parcours

Parcours (PRD) : créer un projet → décrire la vidéo → génération, rendu et
audit visibles → lecture → choix d'une frame exacte → « Ajouter » un ou plusieurs
commentaires (sans IA) → « Envoyer les corrections à l'IA » → plan relu (appliquer
ou rejeter) → nouvelle révision et verdicts de correction → validation → export
MP4. Test : `apps/studio/tests/mvp.e2e.ts`.

## Écrans

| Route | Contenu |
|---|---|
| `/` | Projets récents avec statut du dernier rendu, création, dernières activités de rendu |
| `/projects/[id]` | Gauche : conversation, saisie, ajout de fichiers, progression, demandes assistées à importer. Centre : lecteur image par image (⏮ Lecture ⏭, curseur par frame, « Frame N / M · mm:ss.mmm », fréquence mesurée), barre de scènes, repères d'annotations cliquables, état et version, formulaire « Ajouter ». Droite : validation/export, commentaires (miniature de la frame, sélection, modifier, supprimer, envoi groupé), lots (état, verdicts, relance), plan (conflits, appliquer, rejeter), scène courante, QA, expertise QA (mode d'analyse explicite, verdict, catégorie, confiance, justification, images de preuve, désaccord avec la mesure, relance), historique |
| `/settings` | Choix du fournisseur (`fake`, `anthropic-api`, `claude-subscribe`) avec disponibilité et raison, « Vérifier la disponibilité », avertissement clé API vs abonnement, verrou `VEYRA_AI_PROVIDER` ; moteur, modèles, présence de la clé, formats, stockage, configuration masquée |

Identité : thème sombre, accents violet/bleu/cyan (tokens `@theme` dans
`apps/studio/src/routes/layout.css`), logo officiel copié tel quel depuis
`assets/svg/` vers `apps/studio/static/brand/`. Composants : classes `btn`,
`panel`, `field`, `badge` ; `StatusBadge` pour les états de révision.

## États

Chaque état obligatoire a un rendu explicite : aucun projet, projet sans vidéo,
génération en cours, rendu en cours (barre de progression réelle), audit qualité
en cours, vidéo disponible, révision demandée, échec du rendu (message et fin
de journal), attente de validation, commentaire en attente / dans un lot / envoyé /
appliqué / rejeté / en échec, lot en analyse, attente du résultat de Claude Code,
plan proposé, verdicts de correction. La page interroge le serveur chaque seconde
uniquement pendant un traitement. Le mode simulé est signalé en permanence
(« IA simulée (test) ») et chaque message simulé est préfixé « [Simulé] » ; le
mode assisté est préfixé « [Claude Code — mode assisté] ».

## Accessibilité et adaptation

Lien d'évitement, focus visible cyan, navigation clavier quand le lecteur a le
focus (← → une image, Maj + ← → une seconde, `,` `.`, Début/Fin, Espace/K),
curseur de position natif par frame, libellés sur tous les champs, régions
`aria-live` pour la conversation et les états, respect de `prefers-reduced-motion`.
Sous 1024 px, les trois zones deviennent des onglets (Conversation, Vidéo, Revue).
Non fait : panneaux redimensionnables, audit de contraste outillé, sous-titres.
