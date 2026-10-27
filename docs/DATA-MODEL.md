# Modèle de données

Statut : à compléter lors de la création du projet.

Ce document décrit le modèle conceptuel du domaine : entités métier, attributs,
relations et règles, indépendamment de la technologie de stockage. Sa mise en
œuvre physique (tables, types, index, migrations) est décrite dans
[SCHEMA.md](SCHEMA.md). Les besoins dont il découle sont dans le [PRD](PRD.md).

## Glossaire du domaine

À définir : termes métier, définition et synonymes à éviter. Employer ces termes
dans le code, les documents et les échanges.

| Terme | Définition | À ne pas confondre avec |
|---|---|---|
| À définir | À définir | À définir |

## Entités

À définir : une sous-section par entité métier, sur le modèle ci-dessous.

```markdown
### NomEntité

- Rôle : ce que représente l'entité pour le métier.
- Identité : ce qui la distingue de façon unique.
- Attributs : nom, signification, obligatoire ou non, valeurs admises.
- Propriétaire et source de vérité : composant ou système qui fait référence.
- Sensibilité : selon les règles de [SECURITY.md](SECURITY.md).
```

## Relations

À définir : liens entre entités, cardinalités et dépendances d'existence (par
exemple, une entité qui ne peut exister sans une autre).

## Règles et invariants métier

À définir : règles toujours vraies sur les données, reliées aux exigences du
[PRD](PRD.md) ; leur application technique est décrite dans [SCHEMA.md](SCHEMA.md).

## Cycle de vie et états

À définir : états possibles des entités concernées, transitions autorisées,
événements déclencheurs, archivage et suppression.

## Diagramme

À définir : diagramme entité-relation, par exemple en Mermaid (`erDiagram`),
tenu cohérent avec les sections ci-dessus.

## Questions ouvertes

À définir : notions métier à clarifier et choix de modélisation à valider.
