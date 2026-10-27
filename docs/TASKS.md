# Tâches

Découper la réalisation en tâches ordonnées et vérifiables, issues d'un
[PRD](PRD.md) approuvé, reliées aux exigences du PRD et du TRD et
rattachées à un jalon de la ROADMAP. Une tâche terminée doit inclure
la preuve de sa validation ; signaler les contrôles qui restent impossibles.

## Règles de découpage

- Signaler les exigences ambiguës plutôt que de les supposer.
- Privilégier des tâches qui laissent le projet vérifiable et exécutable.
  Lorsque plusieurs tâches sont indissociables, les regrouper (`G1`, `G2`…) et
  définir le point de validation du groupe.
- Traiter tôt les inconnues à plus fort risque listées dans la
  ROADMAP, par une exploration ou un prototype si nécessaire.
- Pour chaque tâche, indiquer les fichiers concernés, les modifications prévues
  et la manière de les vérifier, selon les conventions de [TESTING.md](TESTING.md).
- Signaler explicitement les migrations de données (voir SCHEMA.md)
  et les nouvelles dépendances (voir [ARCHITECTURE.md](ARCHITECTURE.md)).
- Estimer l'effort de chaque tâche :
  - S : changement limité et localisé, peu de fichiers, test direct ;
  - M : plusieurs fichiers ou composants, ou test d'intégration nécessaire ;
  - L : changement étendu ou incertain ; envisager de découper la tâche.

## Suivi

Aucune tâche définie.

Statuts : à faire | en cours | bloquée | terminée.

## Modèle de tâche

À copier pour chaque nouvelle tâche, dans l'ordre d'exécution :

```markdown
### T001 — Titre

- Statut : à faire
- Effort : S | M | L
- Jalon : J1
- Exigences couvertes : identifiants du PRD et `TR-xxx` du TRD
- Risque levé : aucun | description
- Dépendances : tâches préalables
- Groupe : aucun | G1 — point de validation du groupe
- Fichiers concernés et modifications prévues :
  - `chemin/du/fichier` : modification prévue
- Migration de données : aucune | description et retour arrière
- Nouvelles dépendances : aucune | nom, version, licence
- Vérification : commande ou procédure, et résultat attendu
- État après la tâche : ce qui compile, s'exécute et peut être démontré, ou
  « dans le groupe G1 » si la validation intervient à la fin du groupe
- Résultat et preuves de validation : à renseigner après exécution
- Blocage éventuel : à renseigner si applicable
```
