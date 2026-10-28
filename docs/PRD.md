# Veyra — Besoin produit

Veyra est un studio vidéo conversationnel piloté par IA. Il vise la création de
vidéos courtes à partir d’une intention écrite, avec révisions traçables et
validation humaine avant publication. Le MVP v0.1 livre le parcours complet ;
l'IA réelle reste à valider avec une clé (voir AGENT-WORKFLOWS).

## Parcours MVP

Prompt → conversation → storyboard → révision → rendu → contrôle qualité →
prévisualisation → retours horodatés → plan de correction → nouvelle révision →
validation humaine → export MP4. Formats paysage, portrait et carré configurés
(le MVP génère en paysage) ; durée maximale 60 s ; motion design typographique.

| Exigence | Critère d’acceptation |
|---|---|
| R1 — Projets et échanges persistants | Un projet conserve conversations, messages et références d’assets sur disque. |
| R2 — Contrats partagés | Les entrées invalides sont rejetées ; les scènes ont des identifiants stables et des intervalles non chevauchants. |
| R3 — Configuration déclarative | YAML, JSON et Markdown sont validés ; les couches global/template/projet respectent les clés verrouillées. Le Markdown reste inerte. |
| R4 — Secrets | Les secrets ne sont désignés que par nom de variable ou référence d'environnement ; les vues destinées à la persistance et aux logs sont masquées. Aucun secret n’est versionné. |
| R5 — Révisions et rendus | Les transitions illégales échouent, les erreurs sont persistées, le contenu approuvé ou publié est immuable. |
| R6 — Revue traçable | Chaque retour référence un projet et une révision existants, un temps et éventuellement une scène de cette révision. |
| R7 — Qualité honnête | Chaque rapport et chaque constat indiquent leur mode d’analyse ; une analyse textuelle ou simulée ne se présente pas comme une analyse des images. |
| R8 — Validation humaine | L’approbation précède la publication ; aucun pipeline ne publie automatiquement. |
| R9 — Rendu isolé | Le moteur est appelé sans shell, sous bwrap sans réseau ; les médias sont des fichiers référencés par chemin. |
| R10 — Génération conversationnelle | Le prompt de référence (20 s, sites web et infogérance) produit un storyboard, un rendu HyperFrames réel et une vidéo lisible dans le Studio. |
| R11 — Corrections contextualisées | Un commentaire horodaté est rattaché à la scène jouée ; les commentaires ouverts sont regroupés en un plan relu avant application ; la révision d'origine est conservée. |
| R12 — Export | Seule une révision validée est exportable en MP4. |
| R13 — Annotations par frame | Une frame exacte (index mesuré, FPS entier ou fractionnaire) est sélectionnable ; « Ajouter » persiste le commentaire et sa capture sans appel IA ni rendu ; les brouillons sont modifiables et supprimables ; l'envoi groupé crée un seul lot idempotent ; une erreur conserve les commentaires ; le QA comparatif rend un verdict par commentaire. |
| R15 — Expertise QA | Pour chaque commentaire corrigé, un verdict selon l'intention (dont « contraire à la demande »), avec catégorie technique/contenu/esthétique, confiance et preuves, à partir d'images exactes alignées et de séquences ; mode d'analyse toujours explicite (simulé, texte seul, multimodal) ; fournisseur indisponible signalé ; consultatif, validation humaine maintenue. |
| R14 — Fournisseurs IA | `fake`, `anthropic-api`, `claude-subscribe` choisis explicitement ; aucun basculement automatique ; l'abonnement n'est utilisé que par Claude Code lancé par l'utilisateur (mode assisté, D010). |

## Invariants et exclusions

Préserver les données et révisions antérieures. Une correction après approbation
crée une nouvelle révision. Le chargement d’une configuration n’exécute jamais son
contenu. Les adaptations IA de test doivent être explicitement identifiées.

Hors MVP : montage de rushes, voix off, génération d’images externe.
Les mesures de performance, l’authentification et le déploiement restent à définir.
