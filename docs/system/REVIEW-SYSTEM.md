# Système de revue

Implémenté dans `apps/studio/src/lib/server/studio.ts` (lecteur :
`apps/studio/src/lib/components/FramePlayer.svelte`) ; états et contraintes dans
[PROJECT-SCHEMA](PROJECT-SCHEMA.md).

## Sélection de frame (D012)

- Référence : `video_revisions.media`, mesuré par ffprobe après chaque rendu
  (fréquence rationnelle, durée, `start_time`, nombre de frames, CFR).
- Calculs dans `packages/schemas/src/frames.ts` : `frameAt` (temps → index,
  plancher), `frameFromPts` (horodatage de présentation → index, arrondi),
  `frameTimestampMs` (index → milliseconde entière garantie dans la frame),
  `frameSeekSeconds` (milieu de frame), `stepFrame` (bornes).
- Lecteur : Lecture/Pause, ⏮ ⏭, curseur par frame, numéro de frame et timecode à
  la milliseconde ; quand le lecteur a le focus : ← → une image, Maj + ← → une
  seconde, `,` `.`, Début/Fin, Espace ou K. L'image affichée est lue par
  `requestVideoFrameCallback` (repli `currentTime`).
- Le serveur extrait la frame annotée **par index** : cette capture fait foi.
  Si le média n'est pas CFR, le lecteur l'indique (sélection approximative).

## Parcours

1. **Ajouter** : commentaire `draft` (projet, révision, `frameIndex`, `timestampMs`,
   `fpsNum/fpsDen`, scène, texte, capture). Aucun appel IA, aucun rendu. Les
   brouillons sont modifiables et supprimables ; un clic sur un commentaire ou sur
   son repère de timeline ramène à sa frame.
2. **Envoyer les corrections à l'IA** : les brouillons cochés d'une même révision
   source (en attente de validation) forment un lot `correction_batches`
   (`queued`), dans une transaction ; la clé de soumission du formulaire rend
   l'envoi idempotent. Une seule demande de plan est faite (`submitted`), ou un
   export en mode assisté (`awaiting_import`). Les commentaires ajoutés pendant
   l'analyse restent des brouillons pour un prochain lot.
3. **Plan** (`planned`) : un changement par commentaire (`feedbackId`), patches de
   scène, conflits signalés et non appliqués. L'utilisateur applique ou rejette.
4. **Appliquer** : la révision source passe `changes_requested` (inchangée), une
   révision enfant reçoit le storyboard patché (`origin.batchId`) ; commentaires et
   lot `applied` ; rendu puis QA comparatif ([QUALITY-STANDARDS](../video/QUALITY-STANDARDS.md)).
5. **Expertise QA** (D015) : verdicts par commentaire selon l'intention, avec
   catégorie, confiance et preuves ; consultative, relançable, désaccords avec les
   mesures signalés.
6. **Valider** : révision `approved` (immuable) ; export MP4 réservé aux révisions validées.

Erreur du fournisseur : lot et commentaires `failed`, textes conservés ;
« Relancer » réutilise le même lot et le même fournisseur, jamais un autre (D011).

Scène à composant : le commentaire vise ce composant ; le plan corrige son texte
principal (`text`) ou ses paramètres (`params`), revalidés par le registre ; les autres
composants sont conservés ([MOTION-ENGINE](../video/MOTION-ENGINE.md)).

## Contraintes

- Un plan ne modifie le storyboard que par `scenePatchSchema` (texte, durée,
  type d'entrée, durée d'animation) sur des scènes existantes ; les identifiants
  venant d'un modèle ou d'un `result.json` sont filtrés sur le lot et le storyboard.
- Les identifiants de scène sont conservés entre révisions pour la traçabilité.
- La durée révisée reste ≤ `maxDurationSeconds` ; lots ≤ `review.maxBatchSize`,
  commentaires ≤ `review.maxCommentLength` (`config/app.yaml`).

Limites : pas de multi-utilisateur (auteur fixe « Utilisateur ») ; pas de
réouverture d'un commentaire rejeté (en créer un nouveau).
