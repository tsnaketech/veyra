# API

Statut : optionnel. À compléter si le projet expose ou consomme une API ; sinon,
supprimer ce document et ses renvois (voir [GUIDE.md](GUIDE.md)).

Ce document décrit le contrat des API : points d'accès, formats, erreurs,
authentification et versionnement. Les exigences d'interface (protocoles,
compatibilité, performance) sont fixées dans le [TRD](TRD.md) ; les règles
d'accès dans [SECURITY.md](SECURITY.md). Lorsque le contrat est défini dans un
fichier de spécification (OpenAPI, GraphQL, Protobuf…) ou généré depuis le code,
ce fichier fait référence : ce document le résume et indique son emplacement.

## Vue d'ensemble

À définir : type d'API (REST, GraphQL, RPC, CLI, bibliothèque…), consommateurs
visés, URL de base par environnement (voir [DEPLOYMENT.md](DEPLOYMENT.md)) et
emplacement de la spécification de référence.

## Authentification et autorisation

À définir : mécanisme d'authentification, portées ou rôles requis par opération.
Documenter uniquement des identifiants factices ; les règles sont dans
[SECURITY.md](SECURITY.md).

## Conventions

À définir : formats d'échange, nommage, dates et fuseaux, pagination, tri,
filtrage, idempotence et en-têtes communs.

## Points d'accès

À définir : une sous-section par opération, sur le modèle ci-dessous.

```markdown
### MÉTHODE /chemin

- Rôle : à définir.
- Authentification : à définir.
- Paramètres : nom, emplacement, type, obligatoire, description.
- Corps de la requête : à définir.
- Réponses : code, contenu et cas d'usage.
- Exigences liées : identifiants du PRD et `TR-xxx` du TRD.
- Exemple : requête et réponse avec des données factices.
```

## Erreurs

À définir : format commun des erreurs, codes utilisés et signification, messages
exposés aux consommateurs sans fuite d'information sensible.

## Limites d'usage

À définir : quotas, limitation de débit, taille maximale des requêtes et délais.

## Versionnement et compatibilité

À définir : schéma de version, règles de rupture de compatibilité, dépréciation
et historique des changements.

## API consommées

À définir : API tierces utilisées, usage, authentification, limites, gestion des
pannes et licence ou conditions d'utilisation (à consigner dans
[ARCHITECTURE.md](ARCHITECTURE.md)).

## Tests de contrat

À définir : vérification du respect du contrat et environnement de test ; la
stratégie est décrite dans [TESTING.md](TESTING.md).
