# Déploiement

Statut : à compléter lorsque les environnements cibles sont définis.

Ce document décrit comment le projet est livré et mis en service : environnements,
chaîne de livraison, procédure de déploiement et retour arrière. Les exigences
d'environnement sont fixées dans le [TRD](TRD.md) ; l'exploitation courante, le
diagnostic et les sauvegardes sont dans le [RUNBOOK](RUNBOOK.md). Aucune
procédure de production n'est fournie par ce gabarit ; les mentions « À définir »
ne sont pas des commandes à exécuter.

Obtenir une autorisation explicite avant tout déploiement, intervention en
production ou action destructive, sauf si l'action précise est déjà autorisée.

## Environnements

À définir : environnements (local, test, préproduction, production…), rôle,
hébergement, accès et différences de configuration.

| Environnement | Rôle | Hébergement | Déclenchement | Responsable |
|---|---|---|---|---|
| À définir | À définir | À définir | À définir | À définir |

## Configuration et secrets

À définir : variables d'environnement par environnement et emplacement des
secrets. Documenter uniquement les noms et des valeurs factices ; les règles sont
dans [SECURITY.md](SECURITY.md).

## Chaîne de livraison

Les tests exécutés et leurs conditions de blocage sont définis dans
[TESTING.md](TESTING.md).
À définir : outil d'intégration et de déploiement continus, étapes (build, tests,
analyse, publication des artefacts, déploiement) et conditions de passage.

## Versionnement et publication

À définir : schéma de version, étiquetage, notes de version et artefacts produits.

## Procédure de déploiement

À définir : préconditions, autorisation requise, étapes et commandes exactes,
migrations de données à appliquer (voir [SCHEMA.md](SCHEMA.md)) et durée
d'indisponibilité éventuelle.

## Vérification après déploiement

À définir : contrôles de santé, tests de fumée, métriques à surveiller et
critères de réussite.

## Retour arrière

À définir : conditions de déclenchement, étapes, traitement des migrations de
données et vérification après retour arrière.

## Historique des déploiements

À définir : emplacement du journal des déploiements (date, version,
environnement, résultat), sans données sensibles.
