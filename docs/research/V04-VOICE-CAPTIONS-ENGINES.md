# Moteurs locaux pour Voice & Captions (v0.4) — comparatif

Recherche documentaire du 2026-11-03, menée par deux sous-agents Claude Code (TTS ;
ASR et alignement), relue par l'intégrateur. **Rien n'a été installé, téléchargé ni
exécuté.** Chaque fait vient d'une page ouverte (sources en fin de document) ; aucune
vitesse n'a été mesurée sur la machine cible, aucune écoute n'a été faite. Les
lectures de licence sont techniques, pas juridiques.

Machine cible : 4 vCPU i7-13700T (AVX2, FMA), 16 Go de RAM, pas de GPU, 21 Go
libres, Python 3.11.2 (sans pip, `uv` présent), cmake/gcc, FFmpeg 9.0.2 sans filtre
`whisper`.

## 1. Synthèse vocale (TTS) française

| Moteur | Code | Poids / données | Voix FR | Durées de l'audio produit | Verdict |
|---|---|---|---|---|---|
| **Piper** (`piper-tts` 1.8.0, OHF-Voice/piper1-gpl) | GPL-3.0+ depuis 1.3.0 ; appelé en processus séparé | Par voix (ci-dessous) | siwis, upmc, tom, mls (125 locuteurs), gilles, mls_1840 | **Oui** : nombre d'échantillons par phonème (`include_alignments=True`, voix à patcher une fois) ; mots à reconstruire | **Retenu** |
| Kokoro-82M (kokoro-onnx) | MIT | Apache-2.0 ; voix ff_siwis (SIWIS CC BY 4.0) ; données en partie synthétiques | 1 (femme) | Non pour le français | Secours (écoute comparative) |
| Kyutai Pocket TTS | MIT | CC-BY-4.0, accès conditionnel ; voix de licences variables | estelle | Non (fork communautaire) | Second secours, torch |
| eSpeak NG | GPL-3+ | — | formantique | — | Référence seulement |
| Coqui XTTS-v2 | MPL-2.0 | **CPML non commercial** | clonage | Non | Écarté (licence) |
| MMS-TTS fra | — | **CC-BY-NC 4.0** | 1 | Non | Écarté (licence) |
| F5-TTS / E2 | MIT | **CC-BY-NC** | — | Non | Écarté (licence, GPU) |
| MeloTTS-French | MIT | données inconnues | 1 | — | Écarté |
| Chatterbox multilingual | MIT | — | oui | Non | Écarté (lourd, filigrane audio) |
| sherpa-onnx | Apache-2.0 | selon modèle | via Piper/Kokoro | sans horodatage | Écarté |

Licences des voix Piper françaises (MODEL_CARD) :

| Voix | Données | Base d'entraînement | Conséquence |
|---|---|---|---|
| **`fr_FR-mls-medium`** | MLS (LibriVox), CC-BY 4.0 | de zéro | **Seule voix au statut net** ; attribution CC-BY ; 76,7 Mo, 22 050 Hz |
| `fr_FR-siwis-medium` | SIWIS, CC-BY 4.0 | affinée depuis en_US lessac | lessac interdit l'usage commercial : statut des poids douteux |
| `fr_FR-upmc-medium` | UPMC, CC BY-SA 4.0 | affinée depuis lessac | même réserve |
| `gilles`, `mls_1840` (low) | CC0 / CC-BY | affinées depuis en_US ryan (CC BY-NC-SA) | même réserve |
| `fr_FR-tom-medium` | AGPLv3 | inconnue | effet de l'AGPL sur l'audio : flou |

## 2. Transcription (ASR) française

| Moteur | Code / poids | Qualité FR publiée | Horodatage au mot | Empreinte | Verdict |
|---|---|---|---|---|---|
| **whisper.cpp** v1.9.5 | MIT / MIT | Article Whisper (annexe D) : large-v2 CV9 13,9 %, FLEURS 8,3 % ; pas de chiffre FR pour turbo | Approximatif : jetons `-ml 1` ou `-dtw` (expérimental, exige `-nfa`) | binaire C++, `ggml-large-v3-turbo-q5_0` 547 Mio (SHA-256 publié) | **Retenu** |
| faster-whisper | MIT / MIT | mêmes modèles | DTW approximatif | Python, ctranslate2, PyAV, onnxruntime | Équivalent, plus de dépendances |
| WhisperX | BSD-2 | — | CTC précis, mais aligneur FR par défaut **CC-BY-NC** | torch CUDA, pyannote, triton | Écarté |
| Vosk fr-0.22 | Apache-2.0 | CV 14,7 %, MLS 11,6 % (éditeur) | oui, précision non publiée | léger | Repli possible |
| Parakeet-TDT-0.6b-v3 | CC-BY-4.0 | FLEURS 5,15 % (NVIDIA) | annoncé, non vérifié | NeMo ou sherpa-onnx | À évaluer plus tard |

## 3. Alignement forcé (script connu → temps par mot)

Seules mesures publiées (anglais, arXiv 2509.09987) : F1 des frontières à ±50 ms —
Whisper DTW « têtes fixes » ≈ 41 %, CTC (WhisperX) ≈ 80 %, MFA ≈ 91 %. Aucune
mesure française trouvée.

| Outil | Licence code / modèle | Remarques | Verdict |
|---|---|---|---|
| **torchaudio `forced_align` + `jonatasgrosman/wav2vec2-large-xlsr-53-french`** | BSD / **Apache-2.0** | vocabulaire sans chiffres : nombres à écrire en lettres ; score par mot ; 1,26 Go au format pickle (à convertir en safetensors) ; torch CPU | **Retenu** |
| MMS_FA, `mms-300m-1130-forced-aligner`, VoxPopuli FR | **CC-BY-NC** | défauts de torchaudio, ctc-forced-aligner et WhisperX | Exclus |
| Montreal Forced Aligner | MIT / CC BY 4.0 (FR v3.0.0) | meilleure précision publiée ; conda + Kaldi | Référence hors runtime seulement |
| Whisper DTW sur script imposé | MIT | même moteur que l'ASR, ≈ 41 % à ±50 ms | Repli « approximatif » |
| aeneas, whisper-timestamped | AGPL | aeneas « pas conçu pour le mot » | Exclus |

## 4. Licences des candidats, par composante

Lecture technique des pages citées, pas un avis juridique ; à revérifier sur les
fichiers réellement téléchargés lors des POC.

| Candidat | Logiciel | Poids du modèle | Jeu de données | Attribution | Redistribution |
|---|---|---|---|---|---|
| Piper 1.8.0 | GPL-3.0-or-later | — | — | — | Si Veyra redistribue Piper : fournir les sources (GPL) ; appel en processus séparé sans liaison |
| `fr_FR-mls-medium` | — | Licence des poids : selon MODEL_CARD (Non vérifié au-delà du jeu de données) | MLS (LibriVox), CC-BY 4.0 | Créditer MLS / LibriVox selon CC-BY | Autorisée avec attribution ; à confirmer sur le MODEL_CARD téléchargé |
| whisper.cpp v1.9.5 | MIT | — | — | Notice MIT | Autorisée avec notice |
| Modèles Whisper ggml | — | MIT (OpenAI) | Non publié par OpenAI | Notice MIT | Autorisée avec notice |
| `wav2vec2-large-xlsr-53-french` (candidat T119a) | — | Apache-2.0 (fiche) | Common Voice FR (CC0) + pré-entraînement XLSR-53 : non audités | Notice Apache-2.0 | Autorisée avec notice ; format pickle à convertir |
| torch / torchaudio (si retenus) | BSD | — | — | Notice BSD | Autorisée ; **statut des API d'alignement ≥ 2.9 à revoir (T119a)** |

Exclus sauf validation explicite ultérieure : poids ou données non commerciaux
(MMS-TTS, MMS_FA, `mms-300m-1130-forced-aligner`, VoxPopuli FR, XTTS-v2, F5-TTS,
voix Piper dérivées de lessac ou ryan) et licences AGPL (aeneas, whisper-timestamped,
voix `tom`).

## 5. Points à mesurer sur la machine avant validation définitive

- RTF de Piper medium, whisper.cpp turbo-q5_0 (`-t 4`) et wav2vec2-large CPU ; pic de RAM.
- Piper : patch d'alignement des voix ; somme des durées = longueur du WAV, silences
  inclus ; regroupement phonèmes → mots.
- Écoute française à l'aveugle (locuteurs mls, Kokoro en comparaison) : naturel,
  nombres, dates, sigles ; besoin d'un pré-normaliseur de texte.
- Précision des temps en français (méthode : brief v0.4, critère CA-V7).
- Taille réelle de torch CPU (non vérifiée).

## 6. Sources principales

TTS : github.com/OHF-Voice/piper1-gpl (README, docs/CLI.md, docs/API_PYTHON.md,
docs/ALIGNMENTS.md) ; pypi.org/project/piper-tts ; huggingface.co/rhasspy/piper-voices
(MODEL_CARD fr_FR mls, siwis, upmc, tom, gilles, mls_1840 ; en_US lessac, ryan) ;
cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html ;
huggingface.co/hexgrad/Kokoro-82M ; github.com/thewh1teagle/kokoro-onnx ;
github.com/kyutai-labs/pocket-tts ; huggingface.co/coqui/XTTS-v2 (LICENSE.txt) ;
huggingface.co/facebook/mms-tts-fra ; github.com/SWivid/F5-TTS ;
github.com/myshell-ai/MeloTTS ; github.com/resemble-ai/chatterbox ;
github.com/k2-fsa/sherpa-onnx.

ASR et alignement : github.com/ggml-org/whisper.cpp (README, examples/cli, PR 1485,
whisper.h, models/README, releases) ; huggingface.co/ggerganov/whisper.cpp ;
arxiv.org/html/2212.04356 (Whisper) ; github.com/SYSTRAN/faster-whisper ;
github.com/m-bain/whisperX (pyproject, alignment.py) ; arxiv.org/html/2303.00747v2 ;
arxiv.org/html/2509.09987v1 ; arxiv.org/html/2408.16589v1 ;
alphacephei.com/vosk/models ; huggingface.co/nvidia/parakeet-tdt-0.6b-v3 ;
huggingface.co/jonatasgrosman/wav2vec2-large-xlsr-53-french (fiche, vocab.json) ;
docs.pytorch.org/audio (MMS_FA, VOXPOPULI_ASR_BASE_10K_FR, tutoriel d'alignement
multilingue) ; github.com/pytorch/audio/issues/3902 ;
github.com/MontrealCorpusTools/Montreal-Forced-Aligner ; mfa-models.readthedocs.io ;
github.com/readbeyond/aeneas ; github.com/linto-ai/whisper-timestamped.
