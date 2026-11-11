import { z } from "zod";

/** Declared capabilities of one provider (T139): static, never inferred from a call. */
export const providerCapabilitiesSchema = z.object({
  label: z.string().min(1),
  structured: z.boolean(),
  images: z.boolean(),
  tools: z.enum(["no", "later"]),
  // T129b-1: decideStep (Director of the tool loop) by reliable structured output only.
  director: z.boolean(),
  directorNote: z.string().min(1),
  streaming: z.boolean(),
  cancel: z.boolean(),
  resume: z.boolean(),
  cost: z.enum(["metered-api", "subscription", "none", "local"]),
  limits: z.string().min(1),
  auth: z.string().min(1),
  // operational: usable once configured; prepared: code or study only, off by default.
  status: z.enum(["operational", "prepared", "unavailable", "simulated"]),
  reason: z.string().min(1),
});
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export const capabilityIds = [
  "fake",
  "anthropic-api",
  "claude-subscribe",
  "openai-api",
  "codex-chatgpt",
  "local",
] as const;

export const CODEX_DEFAULT_REASON =
  "Statut contractuel ambigu accepté par l'utilisateur ; installer Codex, `codex login`, puis activer.";

export const providerCapabilities = z
  .record(z.enum(capabilityIds), providerCapabilitiesSchema)
  .parse({
    fake: {
      label: "Simulateur de test — aucun modèle",
      structured: true,
      images: false,
      tools: "no",
      director: true,
      directorNote:
        "Director simulé à règles déterministes, étiqueté « [Simulé] Director » ; ne prouve aucune capacité IA.",
      streaming: false,
      cancel: false,
      resume: false,
      cost: "none",
      limits: "Règles déterministes ; aucune image analysée.",
      auth: "Aucune",
      status: "simulated",
      reason: "Résultats simulés, étiquetés comme tels.",
    },
    "anthropic-api": {
      label: "Claude par API (clé, facturation API)",
      structured: true,
      images: true,
      tools: "no",
      director: true,
      directorNote:
        "Sortie structurée (messages.parse + Zod), chaque pas réservé dans l'enveloppe D022.",
      streaming: false,
      cancel: true,
      resume: false,
      cost: "metered-api",
      limits:
        "Enveloppe budgétaire par production (D022) ; max_tokens et délai de config/models.json.",
      auth: "Clé API (ANTHROPIC_API_KEY)",
      status: "operational",
      reason: "Utilisable avec une clé et un modèle tarifé localement.",
    },
    "claude-subscribe": {
      label: "Claude Code — abonnement, mode assisté",
      structured: true,
      images: true,
      tools: "no",
      director: false,
      directorNote:
        "Mode assisté (D010) : pas d'appel automatique par pas ; non pris en charge en T129b.",
      streaming: false,
      cancel: false,
      resume: false,
      cost: "subscription",
      limits:
        "Manuel : vous lancez Claude Code pour chaque demande ; pas de revue qualitative automatique (D010).",
      auth: "Connexion Claude Code par abonnement (claude.ai)",
      status: "operational",
      reason: "Mode assisté : Veyra n'appelle jamais Claude lui-même.",
    },
    "openai-api": {
      label: "OpenAI par API (clé, facturation API)",
      structured: true,
      // Image token cost is not sourced yet: images are refused (T140).
      images: false,
      tools: "no",
      director: true,
      directorNote:
        "Même chemin ask que codex-chatgpt, réponse revalidée par Zod ; jamais appelé réellement.",
      streaming: false,
      cancel: true,
      resume: false,
      cost: "metered-api",
      limits:
        "Enveloppe D022 avec borne d'entrée d'un jeton par octet ; images refusées faute de borne sourcée.",
      auth: "Clé API OpenAI Platform (OPENAI_API_KEY)",
      status: "prepared",
      reason:
        "Implémenté, jamais appelé réellement ; exige openai.model et un tarif sourcé dans config/models.json.",
    },
    "codex-chatgpt": {
      label: "Codex CLI — abonnement ChatGPT (exécution locale)",
      structured: true,
      images: true,
      tools: "no",
      director: true,
      directorNote:
        "Sortie stricte (--output-schema), coût abonnement, annulable ; jamais appelé réellement pour le Director.",
      streaming: false,
      cancel: true,
      resume: false,
      cost: "subscription",
      limits:
        "Limites du plan ChatGPT, partagées avec votre usage de ChatGPT et Codex (fenêtre de 5 h pour Plus).",
      auth: "`codex login` avec un compte ChatGPT (forced_login_method=chatgpt)",
      status: "prepared",
      reason: CODEX_DEFAULT_REASON,
    },
    local: {
      label: "Modèle local (non implémenté)",
      structured: false,
      images: false,
      tools: "no",
      director: false,
      directorNote: "Préparé : aucun modèle local implémenté (T142).",
      streaming: false,
      cancel: false,
      resume: false,
      cost: "local",
      limits: "Étude seulement : docs/research/LOCAL-AI-AND-CHATGPT-APPS.md.",
      auth: "Aucune",
      status: "prepared",
      reason:
        "Non implémenté ; preuve de concept soumise à autorisation (T142).",
    },
  });
