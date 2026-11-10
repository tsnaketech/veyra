import { z } from "zod";

/** Declared capabilities of one provider (T139): static, never inferred from a call. */
export const providerCapabilitiesSchema = z.object({
  label: z.string().min(1),
  structured: z.boolean(),
  images: z.boolean(),
  tools: z.enum(["no", "later"]),
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
