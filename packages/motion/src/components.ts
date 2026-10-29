import { z } from "zod";
import {
  baseStyle,
  defineComponent,
  escapeHtml,
  formatCounter,
  type BuildContext,
  type Counter,
  type Tween,
} from "./registry";

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const words = (value: string) =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `<span class="w">${escapeHtml(word)}</span>`)
    .join(" ");
const sel = (ctx: BuildContext, path = "") =>
  `${ctx.sceneId}${path ? ` ${path}` : ""}`;
/** Entrance and exit timing that always fits inside the scene. */
const pace = (ctx: BuildContext) => {
  const exit = Math.min(0.4, ctx.durationS * 0.1);
  const entry = Math.max(
    0.2,
    Math.min(ctx.entryS, (ctx.durationS - exit) * 0.4),
  );
  return { entry, exit, settle: ctx.durationS - exit };
};

export const AnimatedTitle = defineComponent({
  id: "animated-title",
  version: 1,
  name: "AnimatedTitle",
  description:
    "Titre en révélation mot par mot, avec surtitre et sous-titre facultatifs.",
  params: z
    .object({
      kicker: optionalText(40),
      title: text(60),
      subtitle: optionalText(90),
    })
    .strict(),
  style: z
    .object({
      ...baseStyle,
      reveal: z.enum(["words", "line"]).default("words"),
    })
    .strict(),
  timing: { minMs: 2000, maxMs: 8000, defaultMs: 4000 },
  capabilities: ["headline", "kinetic-text"],
  primaryField: "title",
  example: {
    kicker: "Nouveau",
    title: "Pilotez votre activité en un clin d'œil",
    subtitle: "Le tableau de bord qui simplifie la gestion des petites équipes",
  },
  build(params, style, ctx) {
    const { entry } = pace(ctx);
    const tweens: Tween[] = [];
    if (params.kicker)
      tweens.push({
        target: sel(ctx, ".kicker"),
        from: { opacity: 0, y: 20 },
        to: { opacity: 1, y: 0 },
        at: 0,
        duration: entry * 0.6,
        ease: "power2.out",
      });
    tweens.push({
      target: sel(ctx, style.reveal === "words" ? ".title .w" : ".title"),
      from: { opacity: 0, y: 48 },
      to: { opacity: 1, y: 0 },
      at: params.kicker ? entry * 0.3 : 0,
      duration: entry,
      ease: "power3.out",
      ...(style.reveal === "words"
        ? { stagger: Math.min(0.12, entry / 4) }
        : {}),
    });
    if (params.subtitle)
      tweens.push({
        target: sel(ctx, ".subtitle"),
        from: { opacity: 0, y: 24 },
        to: { opacity: 1, y: 0 },
        at: entry * 0.9,
        duration: entry * 0.8,
        ease: "power2.out",
      });
    return {
      html:
        (params.kicker
          ? `<p class="kicker">${escapeHtml(params.kicker)}</p>`
          : "") +
        `<h1 class="title">${style.reveal === "words" ? words(params.title) : escapeHtml(params.title)}</h1>` +
        (params.subtitle
          ? `<p class="subtitle">${escapeHtml(params.subtitle)}</p>`
          : ""),
      tweens,
      counters: [],
    };
  },
});

export const FeatureCards = defineComponent({
  id: "feature-cards",
  version: 1,
  name: "FeatureCards",
  description:
    "Deux à quatre cartes de fonctionnalités qui apparaissent en cascade.",
  params: z
    .object({
      heading: optionalText(50),
      cards: z
        .array(z.object({ title: text(32), text: optionalText(90) }).strict())
        .min(2)
        .max(4),
    })
    .strict(),
  style: z
    .object({ ...baseStyle, layout: z.enum(["row", "grid"]).default("row") })
    .strict(),
  timing: { minMs: 3000, maxMs: 10000, defaultMs: 5000 },
  capabilities: ["list", "stagger"],
  primaryField: "heading",
  example: {
    heading: "Tout ce qu'il faut, rien de plus",
    cards: [
      { title: "Tableaux de bord", text: "Vos indicateurs clés en temps réel" },
      { title: "Facturation", text: "Devis et factures en deux clics" },
      { title: "Équipe", text: "Droits et rôles pour chacun" },
    ],
  },
  build(params, style, ctx) {
    const { entry } = pace(ctx);
    const tweens: Tween[] = [];
    if (params.heading)
      tweens.push({
        target: sel(ctx, ".heading"),
        from: { opacity: 0, y: 24 },
        to: { opacity: 1, y: 0 },
        at: 0,
        duration: entry * 0.7,
        ease: "power2.out",
      });
    tweens.push({
      target: sel(ctx, ".card"),
      from: { opacity: 0, y: 60, scale: 0.96 },
      to: { opacity: 1, y: 0, scale: 1 },
      at: params.heading ? entry * 0.5 : 0,
      duration: entry,
      ease: "power3.out",
      stagger: Math.min(0.25, (ctx.durationS * 0.3) / params.cards.length),
    });
    const layout =
      style.layout === "grid" && params.cards.length === 4 ? "grid" : "row";
    return {
      html:
        (params.heading
          ? `<h2 class="heading">${escapeHtml(params.heading)}</h2>`
          : "") +
        `<div class="cards ${layout}">${params.cards
          .map(
            (card, i) =>
              `<div class="card"><span class="card-index">${String(i + 1).padStart(2, "0")}</span><h3>${escapeHtml(card.title)}</h3>${card.text ? `<p>${escapeHtml(card.text)}</p>` : ""}</div>`,
          )
          .join("")}</div>`,
      tweens,
      counters: [],
    };
  },
});

export const MetricsCounter = defineComponent({
  id: "metrics-counter",
  version: 1,
  name: "MetricsCounter",
  description:
    "Une à trois métriques qui comptent jusqu'à leur valeur, avec libellé.",
  params: z
    .object({
      heading: optionalText(50),
      metrics: z
        .array(
          z
            .object({
              value: z.number().min(0).max(1e9),
              decimals: z.number().int().min(0).max(2).default(0),
              prefix: z.string().max(4).default(""),
              suffix: z.string().max(6).default(""),
              label: text(40),
            })
            .strict(),
        )
        .min(1)
        .max(3),
    })
    .strict(),
  style: z.object(baseStyle).strict(),
  timing: { minMs: 3000, maxMs: 8000, defaultMs: 4000 },
  capabilities: ["numbers", "counter"],
  primaryField: "heading",
  example: {
    heading: "Des résultats mesurables",
    metrics: [
      { value: 38, suffix: " %", label: "de temps gagné" },
      { value: 1200, label: "équipes équipées" },
      { value: 4.8, decimals: 1, suffix: "/5", label: "satisfaction client" },
    ],
  },
  build(params, _style, ctx) {
    const { entry, settle } = pace(ctx);
    const countFor = Math.max(
      0.4,
      Math.min(settle * 0.55, settle - entry * 0.5),
    );
    const counters: Counter[] = params.metrics.map((metric, i) => ({
      target: sel(ctx, `.metric-${i} .value`),
      from: 0,
      to: metric.value,
      decimals: metric.decimals,
      prefix: metric.prefix,
      suffix: metric.suffix,
      at: entry * 0.4,
      duration: countFor,
    }));
    const tweens: Tween[] = [
      ...(params.heading
        ? [
            {
              target: sel(ctx, ".heading"),
              from: { opacity: 0, y: 24 },
              to: { opacity: 1, y: 0 },
              at: 0,
              duration: entry * 0.7,
              ease: "power2.out" as const,
            },
          ]
        : []),
      {
        target: sel(ctx, ".metric"),
        from: { opacity: 0, y: 40 },
        to: { opacity: 1, y: 0 },
        at: entry * 0.2,
        duration: entry,
        ease: "power3.out",
        stagger: 0.15,
      },
    ];
    return {
      html:
        (params.heading
          ? `<h2 class="heading">${escapeHtml(params.heading)}</h2>`
          : "") +
        `<div class="metrics">${params.metrics
          .map(
            (metric, i) =>
              `<div class="metric metric-${i}"><span class="value">${escapeHtml(formatCounter(0, metric))}</span><span class="label">${escapeHtml(metric.label)}</span></div>`,
          )
          .join("")}</div>`,
      tweens,
      counters,
    };
  },
});

export const ProductMockup = defineComponent({
  id: "product-mockup",
  version: 1,
  name: "ProductMockup",
  description:
    "Maquette d'interface dessinée en CSS (navigateur ou téléphone) : menu, titre d'écran et graphique animé. Aucune image externe.",
  params: z
    .object({
      appName: text(24),
      screenTitle: text(40),
      items: z.array(text(28)).min(2).max(5),
      chart: z.array(z.number().min(0).max(100)).min(3).max(8),
      caption: optionalText(80),
    })
    .strict(),
  style: z
    .object({
      ...baseStyle,
      device: z.enum(["browser", "phone"]).default("browser"),
    })
    .strict(),
  timing: { minMs: 3000, maxMs: 10000, defaultMs: 4000 },
  capabilities: ["product-ui", "chart", "device-frame"],
  primaryField: "screenTitle",
  example: {
    appName: "Pilot",
    screenTitle: "Activité de la semaine",
    items: ["Accueil", "Clients", "Factures", "Équipe"],
    chart: [32, 48, 41, 66, 58, 79, 92],
    caption: "Une vue claire, dès l'ouverture",
  },
  build(params, style, ctx) {
    const { entry } = pace(ctx);
    const host = `${params.appName.toLowerCase().replace(/[^a-z0-9]+/g, "")}.app`;
    const tweens: Tween[] = [
      {
        target: sel(ctx, ".device"),
        from: { opacity: 0, y: 80, scale: 0.94 },
        to: { opacity: 1, y: 0, scale: 1 },
        at: 0,
        duration: entry,
        ease: "power3.out",
      },
      {
        target: sel(ctx, ".nav-item"),
        from: { opacity: 0, x: -24 },
        to: { opacity: 1, x: 0 },
        at: entry * 0.6,
        duration: entry * 0.6,
        ease: "power2.out",
        stagger: 0.08,
      },
      {
        target: sel(ctx, ".bar"),
        from: { scaleY: 0 },
        to: { scaleY: 1 },
        at: entry * 0.8,
        duration: entry * 1.2,
        ease: "power2.out",
        stagger: 0.07,
      },
    ];
    if (params.caption)
      tweens.push({
        target: sel(ctx, ".caption"),
        from: { opacity: 0, y: 20 },
        to: { opacity: 1, y: 0 },
        at: entry * 1.2,
        duration: entry * 0.7,
        ease: "power2.out",
      });
    return {
      html:
        `<div class="device ${style.device}"><div class="device-bar"><i></i><i></i><i></i><span class="url">${escapeHtml(host)}</span></div>` +
        `<div class="device-body"><nav class="nav"><b class="app-name">${escapeHtml(params.appName)}</b>${params.items
          .map((item) => `<span class="nav-item">${escapeHtml(item)}</span>`)
          .join("")}</nav>` +
        `<main class="screen"><h3 class="screen-title">${escapeHtml(params.screenTitle)}</h3><div class="chart">${params.chart
          .map(
            (value) =>
              `<span class="bar" style="height:${Math.max(4, value)}%"></span>`,
          )
          .join("")}</div></main></div></div>` +
        (params.caption
          ? `<p class="caption">${escapeHtml(params.caption)}</p>`
          : ""),
      tweens,
      counters: [],
    };
  },
});

export const CallToAction = defineComponent({
  id: "call-to-action",
  version: 1,
  name: "CallToAction",
  description:
    "Accroche finale, bouton d'action qui pulse une fois et ligne de contact.",
  params: z
    .object({
      headline: text(60),
      buttonLabel: text(28),
      detail: optionalText(60),
    })
    .strict(),
  style: z.object(baseStyle).strict(),
  timing: { minMs: 2000, maxMs: 6000, defaultMs: 3000 },
  capabilities: ["call-to-action", "pulse"],
  primaryField: "headline",
  example: {
    headline: "Prêt à gagner du temps ?",
    buttonLabel: "Essai gratuit 14 jours",
    detail: "pilot.app",
  },
  build(params, _style, ctx) {
    const { entry, settle } = pace(ctx);
    const tweens: Tween[] = [
      {
        target: sel(ctx, ".headline"),
        from: { opacity: 0, scale: 0.92 },
        to: { opacity: 1, scale: 1 },
        at: 0,
        duration: entry,
        ease: "back.out(1.4)",
      },
      {
        target: sel(ctx, ".button"),
        from: { opacity: 0, y: 30 },
        to: { opacity: 1, y: 0 },
        at: entry * 0.6,
        duration: entry * 0.8,
        ease: "power2.out",
      },
    ];
    const pulseAt = entry * 1.6;
    if (pulseAt + 0.6 < settle)
      tweens.push({
        target: sel(ctx, ".button-inner"),
        from: { scale: 1 },
        to: { scale: 1.06 },
        at: pulseAt,
        duration: 0.3,
        ease: "sine.inOut",
        repeat: 1,
        yoyo: true,
      });
    if (params.detail)
      tweens.push({
        target: sel(ctx, ".detail"),
        from: { opacity: 0 },
        to: { opacity: 1 },
        at: entry,
        duration: entry * 0.6,
        ease: "power1.out",
      });
    return {
      html:
        `<h2 class="headline">${escapeHtml(params.headline)}</h2>` +
        `<div class="button"><span class="button-inner">${escapeHtml(params.buttonLabel)}</span></div>` +
        (params.detail
          ? `<p class="detail">${escapeHtml(params.detail)}</p>`
          : ""),
      tweens,
      counters: [],
    };
  },
});
