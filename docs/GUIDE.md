# Guide des documents

Détail de chaque document du projet : rôle, contenu, limites, liens et moment de
mise à jour. Le tableau court de [AGENTS.md](../AGENTS.md) sert d'index ; ce guide
fait référence pour la répartition des contenus entre documents. Le contenu de
chaque rubrique reste défini dans le document lui-même.

## Vue d'ensemble

| Document | Applicabilité | Question à laquelle il répond |
|---|---|---|
| [PRD](PRD.md) | Obligatoire | Quel besoin, pour qui, avec quel périmètre ? |
| TRD | Optionnel | Quelles exigences techniques mesurables ? |
| [ARCHITECTURE](ARCHITECTURE.md) | Obligatoire | Comment la solution est-elle construite ? |
| DATA-MODEL | Optionnel | Quelles notions métier et quelles règles ? |
| SCHEMA | Optionnel | Comment les données sont-elles stockées ? |
| DATABASE-SETUP | Optionnel | Comment installer et préparer la base ? |
| API | Optionnel | Quel contrat pour les API exposées ou consommées ? |
| DESIGN | Optionnel | Comment l'utilisateur interagit-il ? |
| ROADMAP | Optionnel | Dans quel ordre livrer, avec quels risques ? |
| [TASKS](TASKS.md) | Obligatoire | Quelles tâches, comment les vérifier, où en est-on ? |
| [TESTING](TESTING.md) | Obligatoire | Comment vérifier que la solution fonctionne ? |
| [SECURITY](SECURITY.md) | Obligatoire | Quelles données, quels accès, quelles protections ? |
| [DECISIONS](DECISIONS.md) | Obligatoire | Quels choix durables, et pourquoi ? |
| [RUNBOOK](RUNBOOK.md) | Obligatoire | Quelles commandes exécuter, et comment diagnostiquer ? |
| DEPLOYMENT | Optionnel | Comment livrer et revenir en arrière ? |
| [MEMORY](../memory/MEMORY.md) | Obligatoire | Où en est-on à la fin de la dernière session ? |

Un document optionnel qui ne s'applique pas est supprimé avec ses renvois, ou
conservé avec la mention de sa non-applicabilité et sa raison.

## Répartition si un document optionnel est absent

Lorsqu'un document optionnel est absent mais qu'une partie de son contenu reste
utile, la placer dans le document indiqué, sans créer de nouveau fichier.

| Document absent | Contenu à placer dans |
|---|---|
| TRD | PRD, rubrique « Contraintes et invariants » |
| DATA-MODEL | PRD pour le glossaire et les règles métier ; SCHEMA pour la correspondance entre entités et tables |
| SCHEMA | ARCHITECTURE, rubrique « Données et flux » |
| DATABASE-SETUP | RUNBOOK pour l'installation et les commandes ; TESTING pour la base de test |
| API | ARCHITECTURE pour les intégrations ; TRD, ou PRD à défaut, pour les exigences d'interface |
| DESIGN | PRD, rubrique « Parcours et exigences » |
| ROADMAP | TASKS : omettre le champ « Jalon » et noter les risques dans les tâches qui les lèvent |
| DEPLOYMENT | RUNBOOK, rubrique « Déploiement et retour arrière » |

Si le contenu reporté devient important, créer le document optionnel et y
déplacer ce contenu.

## Plans détaillés

Un changement transversal, risqué ou en plusieurs phases peut justifier un plan
dans `docs/plans/`, créé uniquement si sa complexité le demande. Nommer le
fichier `AAAA-MM-JJ-sujet.md` et y décrire l'objectif, l'approche, les tâches
`T00x` concernées, les risques et le point de validation.

Le plan ne suit pas l'avancement : [TASKS.md](TASKS.md) reste la référence. Une
fois le travail validé, indiquer en tête du plan qu'il est terminé, avec un
renvoi vers les tâches correspondantes.

## Ordre de remplissage

1. PRD, puis TRD si les exigences techniques le justifient.
2. DATA-MODEL si le domaine comporte des notions ou règles métier à formaliser.
3. ARCHITECTURE et DECISIONS au choix de la stack ; SECURITY dès que les données
   et les accès sont connus.
4. SCHEMA et DATABASE-SETUP au choix du stockage ; API si le projet en expose ou
   en consomme une ; DESIGN si une interface utilisateur existe.
5. ROADMAP, puis TASKS.
6. TESTING avant la première tâche ; RUNBOOK au fil de l'installation ;
   DEPLOYMENT avant la première livraison.
7. MEMORY en fin de session.

## Identifiants et traçabilité

| Préfixe | Défini dans | Référencé par |
|---|---|---|
| `PR-001` | PRD | TASKS, TESTING |
| `TR-001` | TRD | ARCHITECTURE, SCHEMA, API, TASKS, TESTING |
| `J1` | ROADMAP | TASKS |
| `T001` | TASKS | ROADMAP (risques), plans détaillés |
| `G1` | TASKS (groupe de tâches indissociables) | TASKS |
| `D001` | DECISIONS | ARCHITECTURE et tout document concerné |

Chaîne attendue : exigence du PRD → exigence `TR-xxx` → jalon → tâche → preuve de
validation dans TASKS.

## Principe de répartition

Chaque information possède un document de référence.

Les autres documents peuvent en présenter un résumé nécessaire à leur
compréhension, accompagné d'un lien vers la référence.

Les rubriques « Ne contient pas » interdisent la duplication détaillée,
pas les résumés ni les renvois.



## Détail par document

### PRD — Définition du produit

- Rôle : besoin, utilisateurs, périmètre, exigences fonctionnelles et critères
  d'acceptation.
- Ne contient pas : exigences techniques (TRD), jalons (ROADMAP), choix de
  solution (ARCHITECTURE).
- Mettre à jour : à chaque évolution du besoin ou du périmètre.

### TRD — Exigences techniques

- Rôle : exigences non fonctionnelles mesurables (performance, disponibilité,
  compatibilité, données, observabilité) et leur méthode de vérification.
- Ne contient pas : la solution qui y répond (ARCHITECTURE, SCHEMA) ni la mise en
  œuvre des environnements (DEPLOYMENT).
- Optionnel : si les exigences techniques sont nombreuses ou chiffrées.
- Mettre à jour : à chaque nouvelle contrainte ou changement de seuil.

### ARCHITECTURE

- Rôle : état actuel de la solution — stack, composants, flux, couverture des
  exigences `TR-xxx`, dépendances et licences.
- Ne contient pas : justification des choix (DECISIONS), modèle de données
  (DATA-MODEL, SCHEMA).
- Mettre à jour : à chaque changement de composant, de flux ou de dépendance
  structurante.

### DATA-MODEL — Modèle conceptuel

- Rôle : glossaire du domaine, entités métier, relations, règles et cycle de vie,
  indépendamment du stockage.
- Ne contient pas : tables, types ou index (SCHEMA).
- Optionnel : utile dès que le domaine comporte des notions ou règles à partager.
- Mettre à jour : à chaque évolution d'une notion ou d'une règle métier.

### SCHEMA — Schéma physique

- Rôle : tables ou collections, types, clés, contraintes, index, politique de
  migration et fixtures.
- Ne contient pas : commandes d'installation ou de migration (DATABASE-SETUP),
  sens métier des entités (DATA-MODEL).
- Optionnel : uniquement avec des données persistantes. Si le schéma est défini
  dans le code, le code fait référence et ce document le résume.
- Mettre à jour : à chaque migration.

### DATABASE-SETUP — Mise en place de la base

- Rôle : moteur et version, installation locale, connexion, rôles, commandes de
  migration et de données de test, base de test automatisée.
- Ne contient pas : sauvegardes (RUNBOOK), migrations en production (DEPLOYMENT),
  règles d'accès (SECURITY).
- Optionnel : uniquement avec une base de données à installer.
- Mettre à jour : à chaque changement de moteur, de configuration ou de commande.

### API — Contrat d'interface

- Rôle : type d'API, authentification, conventions, points d'accès, erreurs,
  limites d'usage, versionnement, API tierces consommées et tests de contrat.
- Ne contient pas : exigences d'interface (TRD), règles d'accès (SECURITY), URL
  et configuration des environnements (DEPLOYMENT).
- Optionnel : uniquement si le projet expose ou consomme une API. Si une
  spécification (OpenAPI, GraphQL…) existe, elle fait référence et ce document la
  résume.
- Mettre à jour : à chaque changement de contrat, avant sa publication.

### DESIGN — Expérience utilisateur

- Rôle : parcours, interfaces, états, interactions et accessibilité.
- Ne contient pas : exigences fonctionnelles (PRD), contrat d'API (API).
- Optionnel : uniquement avec une interface utilisateur (graphique ou CLI).
- Mettre à jour : à chaque changement d'expérience utilisateur.

### ROADMAP — Feuille de route

- Rôle : jalons, livrables, ordre de livraison, dépendances entre jalons, risques
  et inconnues avec la tâche qui les lève.
- Ne contient pas : détail ni suivi des tâches (TASKS), exclusions de périmètre
  (PRD).
- Optionnel : si le projet comporte plusieurs jalons ou livraisons.
- Mettre à jour : à chaque changement de priorité, d'échéance ou de jalon.

### TASKS — Tâches

- Rôle : tâches ordonnées laissant de préférence le projet exécutable, groupes de
  tâches indissociables avec leur point de validation, effort S/M/L, fichiers,
  modifications, vérification, migrations, nouvelles dépendances et preuves de
  validation. Référence de l'avancement.
- Ne contient pas : vue d'ensemble des jalons (ROADMAP).
- Mettre à jour : à chaque découpage et à chaque changement de statut.

### TESTING — Tests

- Rôle : stratégie, niveaux de test, outils, commandes de test, de lint, de
  formatage et de vérification des types, conventions, données de test, seuils,
  vérifications en intégration continue et traçabilité exigences → tests.
- Ne contient pas : la vérification propre à chaque tâche (TASKS), la base de test
  (DATABASE-SETUP), la chaîne de livraison complète (DEPLOYMENT).
- Mettre à jour : à chaque changement d'outil, de convention, de seuil ou de
  couverture d'une exigence.

### SECURITY — Sécurité

- Rôle : données traitées et leur sensibilité, secrets, accès, menaces,
  protections, vérifications et signalement.
- Ne contient pas : valeurs de secrets, procédures opérationnelles (RUNBOOK).
- Mettre à jour : à chaque changement de risque, d'accès ou de protection.

### DECISIONS — Journal des décisions

- Rôle : choix durables avec contexte, options, justification et conséquences ;
  les décisions remplacées sont conservées et reliées à leur successeur.
- Ne contient pas : détails courants d'implémentation.
- Mettre à jour : à chaque décision acceptée ou remplacée.

### RUNBOOK — Exploitation

- Rôle : prérequis, variables d'environnement, commandes exactes (installation,
  build, démarrage), diagnostic, sauvegarde et restauration.
- Ne contient pas : procédure de déploiement (DEPLOYMENT), installation de la base
  (DATABASE-SETUP), commandes de test, de lint, de formatage et de types
  (TESTING).
- Mettre à jour : à chaque changement d'outil, de commande ou de configuration.

### DEPLOYMENT — Déploiement

- Rôle : environnements, configuration par environnement, chaîne de livraison,
  versionnement, procédure de déploiement, vérification et retour arrière.
- Ne contient pas : exigences d'environnement (TRD), exploitation courante
  (RUNBOOK).
- Optionnel : si le projet est déployé sur des environnements distants.
- Mettre à jour : à chaque changement d'environnement ou de procédure.

### MEMORY — Mémoire de reprise

- Rôle : état utile à la prochaine session, points à revérifier et prochaine
  étape, datés.
- Ne contient pas : tâches (TASKS), décisions (DECISIONS), règles (AGENTS.md),
  journaux de conversation ni secrets.
- Mettre à jour : en fin de session, en supprimant les notes périmées.

MEMORY est une aide à la reprise, pas une source de vérité sur le projet.

En cas de divergence, vérifier l'état du code, TASKS et les documents de
référence concernés, puis corriger la mémoire.

Les éléments de MEMORY ne doivent pas modifier implicitement une exigence,
une décision ou le statut d'une tâche.

## Ajouter ou retirer un document

1. Vérifier qu'aucun document existant ne couvre déjà le besoin.
2. Définir son rôle et ses limites dans ce guide, et ajuster les documents
   voisins pour éviter les doublons.
3. Mettre à jour le tableau de [AGENTS.md](../AGENTS.md), la structure du
   README s'il existe, et les renvois.
4. Consigner le changement dans [DECISIONS.md](DECISIONS.md) s'il modifie la
   répartition des contenus.
