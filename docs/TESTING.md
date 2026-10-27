# Tests

Statut : à compléter lorsque la stack est choisie. Si une rubrique ne s'applique
pas, le préciser avec sa raison.

Ce document décrit la stratégie de vérification : niveaux de test, outils,
conventions, commandes de test, de lint, de formatage et de vérification des
types, et règles de validation. Les exigences à vérifier sont dans le
[PRD](PRD.md) et le TRD ; la vérification propre à chaque tâche est
indiquée dans [TASKS.md](TASKS.md). Ne jamais annoncer un test réussi sans
l'avoir exécuté ; les mentions « À définir » ne sont pas des commandes à exécuter.

## Stratégie

À définir : objectifs des tests, risques couverts en priorité et répartition entre
niveaux de test.

## Niveaux de test

| Niveau | Portée | Outil | Emplacement | Exécution |
|---|---|---|---|---|
| Unitaire | À définir | À définir | `tests/` (à préciser) | À définir |
| Intégration | À définir | À définir | À définir | À définir |
| Bout en bout | À définir | À définir | À définir | À définir |
| Non fonctionnel (performance, accessibilité…) | À définir | À définir | À définir | À définir |

Supprimer les niveaux non applicables ou indiquer leur raison.

## Commandes

| Opération | Commande | Résultat attendu |
|---|---|---|
| Lancer tous les tests | À définir | À définir |
| Lancer un fichier ou un test précis | À définir | À définir |
| Mesurer la couverture | À définir | À définir |
| Lancer les tests en mode surveillance | À définir | À définir |
| Vérifier le formatage | À définir | À définir |
| Lancer le lint et l'analyse statique | À définir | À définir |
| Vérifier les types | À définir | À définir |
| Lancer toutes les vérifications avant livraison | À définir | À définir |

## Conventions

À définir : nommage et organisation des fichiers de test, structure d'un test,
usage des doublures (mocks, stubs), tests déterministes et indépendants de
l'ordre d'exécution.

## Données et environnement de test

À définir : jeux de données factices (décrits dans SCHEMA.md), base
de test (voir DATABASE-SETUP.md), services externes simulés
et variables d'environnement propres aux tests. Ne jamais utiliser de données
réelles ou sensibles.

## Couverture et seuils

À définir : seuil de couverture éventuel, parties exclues avec leur raison et
critères de blocage.

## Intégration continue

À définir : tests exécutés à chaque modification et avant livraison, conditions
de blocage. La chaîne complète est décrite dans DEPLOYMENT.md.

## Traçabilité des exigences

À définir : correspondance entre exigences du PRD, exigences `TR-xxx` du TRD et
tests qui les vérifient.

| Exigence | Test ou vérification | Niveau | Statut |
|---|---|---|---|
| À définir | À définir | À définir | À définir |

## Tests manuels

À définir : vérifications qui ne peuvent pas être automatisées, procédure et
critère de réussite.

## Tests instables et limites connues

À définir : tests instables, cause connue, mesure prévue et contrôles impossibles
dans l'environnement actuel.
