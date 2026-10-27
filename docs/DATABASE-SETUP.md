# Mise en place de la base de données

Statut : à compléter lorsque le stockage est choisi. Si le projet n'utilise pas de
base de données, le préciser ici avec sa raison.

Ce document décrit comment installer, configurer et préparer la base de données
dans chaque environnement. Le modèle de données et la politique de migration sont
dans [SCHEMA.md](SCHEMA.md) ; le choix du stockage est justifié dans
[DECISIONS.md](DECISIONS.md). Les mentions « À définir » ne sont pas des
commandes à exécuter.

Obtenir une autorisation explicite avant toute action destructive (suppression,
réinitialisation, restauration) ou toute intervention sur une base de production,
sauf si l'action précise est déjà autorisée.

## Moteur et version

À définir : moteur de base de données, version minimale et version de
référence, extensions nécessaires et licence (à consigner dans
[ARCHITECTURE.md](ARCHITECTURE.md)).

## Installation locale

À définir : méthode d'installation reproductible (paquet, conteneur, service
géré), commandes exactes et signe de réussite.

| Opération | Commande | Résultat attendu |
|---|---|---|
| Démarrer la base locale | À définir | À définir |
| Créer la base et les rôles | À définir | À définir |
| Appliquer les migrations | À définir | À définir |
| Charger les données de test | À définir | À définir |
| Réinitialiser la base locale | À définir | À définir |
| Arrêter la base locale | À définir | À définir |

## Connexion et configuration

À définir : variables d'environnement de connexion (noms et valeurs factices
uniquement), paramètres de pool et de délai. Les règles sur les secrets sont dans
[SECURITY.md](SECURITY.md).

## Rôles et accès

À définir : comptes et rôles de base de données, permissions minimales par
composant et par environnement.

## Migrations

À définir : commandes pour créer, appliquer, vérifier et annuler une migration.
L'outil, l'emplacement et la politique de versionnement sont définis dans
[SCHEMA.md](SCHEMA.md) ; l'application en production suit
[DEPLOYMENT.md](DEPLOYMENT.md).

## Données de test

À définir : commandes de chargement des jeux de données factices décrits dans
[SCHEMA.md](SCHEMA.md). Ne jamais charger de données réelles ou sensibles hors
production.

## Base de test automatisée

À définir : création, isolation et nettoyage de la base utilisée par les tests,
en local et en intégration continue.

## Sauvegarde et restauration

Les procédures de sauvegarde et de restauration sont dans le
[RUNBOOK](RUNBOOK.md). À définir ici : particularités propres au moteur, si
nécessaire.

## Dépannage

À définir : erreurs courantes d'installation ou de connexion et leur résolution.
