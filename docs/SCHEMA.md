# Schéma de données

Statut : à compléter lorsque le stockage est choisi.

Ce document décrit le schéma physique : la mise en œuvre du
[modèle de données](DATA-MODEL.md) dans le stockage choisi (tables ou collections,
types, contraintes, index et migrations). Les exigences de données (volumes,
intégrité, conservation) sont fixées dans le [TRD](TRD.md) ; les flux et le
stockage sont décrits dans [ARCHITECTURE.md](ARCHITECTURE.md). Lorsque le schéma
est défini dans le code (migrations, définitions de types, fichiers de schéma), ce
code fait référence : ce document le résume et renvoie vers ses fichiers sources.

## Vue d'ensemble

À définir : système de stockage utilisé et correspondance entre les entités du
[modèle de données](DATA-MODEL.md) et les tables ou collections.

## Tables ou collections

À définir : une sous-section par table ou collection, sur le modèle ci-dessous.
Reprendre la sensibilité indiquée dans le [modèle de données](DATA-MODEL.md).

```markdown
### nom_table

Entité du modèle : NomEntité.

| Champ | Type | Obligatoire | Contraintes | Sensibilité | Description |
|---|---|---|---|---|---|
| id | À définir | oui | identifiant unique | À définir | À définir |
```

## Clés et relations

À définir : clés primaires et étrangères, tables d'association et règles de
suppression ou de mise à jour en cascade.

## Contraintes et index

À définir : unicité, validations, index et mise en œuvre des invariants du
[modèle de données](DATA-MODEL.md), reliés aux exigences `TR-xxx` du
[TRD](TRD.md) lorsque pertinent.

## Évolution et migrations

À définir : versionnement du schéma, outil et emplacement des migrations,
compatibilité avec les données existantes et procédure de retour arrière. Les
commandes exactes sont documentées dans [DATABASE-SETUP.md](DATABASE-SETUP.md).

## Données de test et exemples

À définir : jeux de données factices et emplacement des fixtures ; leur
chargement est décrit dans [DATABASE-SETUP.md](DATABASE-SETUP.md). Ne jamais
utiliser de données réelles ou sensibles dans les exemples.

## Questions ouvertes

À définir : choix techniques de schéma à valider et informations manquantes.
