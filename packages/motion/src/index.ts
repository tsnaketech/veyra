import { z } from "zod";
import { newId, type SceneComponent, type Storyboard } from "@veyra/schemas";
import {
  AnimatedTitle,
  CallToAction,
  FeatureCards,
  MetricsCounter,
  ProductMockup,
} from "./components";
import {
  counterSchema,
  tweenSchema,
  type BuildContext,
  type BuiltScene,
  type MotionComponent,
} from "./registry";

export * from "./registry";
export {
  AnimatedTitle,
  CallToAction,
  FeatureCards,
  MetricsCounter,
  ProductMockup,
};

/** The registry: the only components a storyboard may reference. */
export const motionComponents = [
  AnimatedTitle,
  FeatureCards,
  ProductMockup,
  MetricsCounter,
  CallToAction,
] as const satisfies readonly MotionComponent[];
export type ComponentId = (typeof motionComponents)[number]["id"];
export const componentIds = motionComponents.map((c) => c.id) as [
  ComponentId,
  ...ComponentId[],
];
export const registryVersion = 1;

export function getComponent(id: string): MotionComponent {
  const component = motionComponents.find((c) => c.id === id);
  if (!component) throw new Error(`Composant inconnu : ${id}`);
  return component as unknown as MotionComponent;
}

/** What a model may write in a storyboard scene: one registered component with its parameters. */
export const componentDraftSchema = z.discriminatedUnion(
  "id",
  motionComponents.map((c) =>
    z
      .object({
        id: z.literal(c.id),
        params: c.params,
        style: c.style.optional(),
      })
      .strict(),
  ) as unknown as [z.ZodObject, ...z.ZodObject[]],
);
export type ComponentDraft = z.infer<typeof componentDraftSchema>;

/** Validates a stored reference (id, version, params, style) against the registry. */
export function resolveComponent(ref: {
  id: string;
  version: number;
  params: unknown;
  style?: unknown;
}) {
  const component = getComponent(ref.id);
  if (ref.version !== component.version)
    throw new Error(`Version ${ref.version} de ${ref.id} non prise en charge`);
  return {
    component,
    params: component.params.parse(ref.params) as Record<string, unknown>,
    style: component.style.parse(ref.style ?? {}) as Record<string, unknown>,
  };
}
/** Canonical stored form: parsed params (defaults applied) and style. */
export function normalizeComponent(ref: {
  id: string;
  params: unknown;
  style?: unknown;
}): SceneComponent {
  const component = getComponent(ref.id);
  const { params, style } = resolveComponent({
    ...ref,
    version: component.version,
  });
  // Zod output of JSON-only schemas: plain JSON values.
  return {
    id: component.id,
    version: component.version,
    // JSON round trip drops optional keys left undefined by Zod.
    params: JSON.parse(JSON.stringify(params)) as SceneComponent["params"],
    style: JSON.parse(JSON.stringify(style)) as SceneComponent["style"],
  };
}
export const componentLabel = (ref: { id: string; params: unknown }) => {
  const component = getComponent(ref.id);
  const value = (ref.params as Record<string, unknown>)[component.primaryField];
  return typeof value === "string" && value ? value : component.name;
};

/** Checks a scene duration against the component's declared constraints. */
export function checkTiming(id: string, durationMs: number) {
  const { timing, name } = getComponent(id);
  if (durationMs < timing.minMs || durationMs > timing.maxMs)
    throw new Error(
      `${name} : durée ${durationMs} ms hors de [${timing.minMs}, ${timing.maxMs}] ms`,
    );
}

export function buildComponentScene(
  ref: { id: string; version: number; params: unknown; style?: unknown },
  ctx: BuildContext,
): BuiltScene & {
  accent: keyof BuildContext["palette"];
  align: "left" | "center";
} {
  const { component, params, style } = resolveComponent(ref);
  const built = component.build(params, style, ctx);
  // Defence in depth: whatever a component returns is re-validated as plain data.
  return {
    accent:
      (style.accent as BuildContext["palette"] extends Record<infer K, string>
        ? K
        : never) ?? "cyan",
    align: style.align === "left" ? ("left" as const) : ("center" as const),
    html: built.html,
    tweens: built.tweens.map((t) => tweenSchema.parse(t)),
    counters: built.counters.map((c) => counterSchema.parse(c)),
  };
}

/** One-scene storyboard showing a component with its example parameters. */
export function previewStoryboard(id: string, params?: unknown): Storyboard {
  const component = getComponent(id);
  const ref = normalizeComponent({ id, params: params ?? component.example });
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [
      {
        id: newId("scn"),
        start: 0,
        duration: component.timing.defaultMs,
        text: componentLabel(ref),
        animation: { enter: "fade", durationMs: 800, easing: "power2.out" },
        component: ref,
      },
    ],
  };
}

/** Static stylesheet for every component; sizes derive from the frame height, never below
 * 2.6 % of it (HyperFrames text_below_floor: 28 px at 1080p). */
export function motionCss(width: number, height: number) {
  const u = height / 100;
  const px = (k: number) => `${Math.round(k * u)}px`;
  return `
.scene .stage{position:absolute;inset:7% 8%;display:flex;flex-direction:column;justify-content:center;gap:${px(3)};color:#fff;text-align:center;align-items:center}
.scene .stage.align-left{text-align:left;align-items:flex-start}
.scene h1,.scene h2,.scene h3,.scene p{margin:0}
.scene .kicker{font-size:${px(2.8)};font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#fff;background:rgba(11,13,23,.55);padding:${px(0.8)} ${px(2)};border-radius:999px;box-shadow:inset 0 0 0 ${px(0.3)} var(--accent)}
.scene .title{font-size:${px(8.5)};font-weight:800;line-height:1.08;max-width:${Math.round(width * 0.78)}px}
.scene .title .w{display:inline-block}
.scene .subtitle{font-size:${px(3.6)};opacity:.92;max-width:${Math.round(width * 0.6)}px;line-height:1.3}
.scene .heading{font-size:${px(5.2)};font-weight:800;line-height:1.1}
.scene .cards{display:flex;gap:${px(2.5)};width:100%;justify-content:center}
.scene .cards.grid{display:grid;grid-template-columns:1fr 1fr}
.scene .card{flex:1;max-width:${Math.round(width * 0.27)}px;background:rgba(11,13,23,.55);border:1px solid rgba(255,255,255,.18);border-radius:${px(2)};padding:${px(3)};text-align:left}
.scene .card-index{font-size:${px(2.6)};font-weight:700;color:var(--accent)}
.scene .card h3{font-size:${px(3.6)};margin-top:${px(1)};line-height:1.15}
.scene .card p{font-size:${px(2.6)};opacity:.9;margin-top:${px(1)};line-height:1.3}
.scene .metrics{display:flex;gap:${px(6)};justify-content:center}
.scene .metric{display:flex;flex-direction:column;align-items:center;gap:${px(1)}}
.scene .value{font-size:${px(10)};font-weight:800;font-variant-numeric:tabular-nums;color:#fff;text-shadow:0 0 ${px(3)} var(--accent)}
.scene .label{font-size:${px(2.8)};opacity:.92}
.scene .device{width:${Math.round(width * 0.62)}px;height:${Math.round(height * 0.6)}px;background:#0b0d17;border-radius:${px(1.6)};border:1px solid rgba(255,255,255,.2);overflow:hidden;display:flex;flex-direction:column;box-shadow:0 ${px(3)} ${px(8)} rgba(0,0,0,.45)}
.scene .device.phone{width:${Math.round(height * 0.34)}px;height:${Math.round(height * 0.68)}px;border-radius:${px(4)}}
.scene .device-bar{display:flex;align-items:center;gap:${px(0.8)};padding:${px(1.2)} ${px(1.6)};background:#12152a}
.scene .device-bar i{width:${px(1.2)};height:${px(1.2)};border-radius:50%;background:#3a3f66}
.scene .url{margin-left:${px(1.5)};font-size:${px(2.6)};color:#9aa0b8}
.scene .device-body{flex:1;display:flex;min-height:0}
.scene .nav{width:28%;background:#12152a;padding:${px(2)};display:flex;flex-direction:column;gap:${px(1.4)};text-align:left}
.scene .device.phone .nav{display:none}
.scene .app-name{font-size:${px(2.6)};color:var(--accent)}
.scene .nav-item{font-size:${px(2.6)};color:#cdd1e4}
.scene .screen{flex:1;padding:${px(2.4)};display:flex;flex-direction:column;gap:${px(2)};text-align:left}
.scene .screen-title{font-size:${px(3)};color:#e7e9f3}
.scene .chart{flex:1;display:flex;align-items:flex-end;gap:${px(1.2)}}
.scene .bar{flex:1;background:linear-gradient(180deg,var(--accent),#7c3aed);border-radius:${px(0.6)} ${px(0.6)} 0 0;transform-origin:50% 100%}
.scene .caption{font-size:${px(3)};opacity:.92}
.scene .headline{font-size:${px(7.5)};font-weight:800;line-height:1.08;max-width:${Math.round(width * 0.75)}px}
.scene .button{display:inline-block}
.scene .button-inner{display:inline-block;font-size:${px(3.6)};font-weight:700;color:#0b0d17;background:#fff;border-radius:999px;padding:${px(1.8)} ${px(4.5)};box-shadow:0 0 0 ${px(0.6)} var(--accent)}
.scene .detail{font-size:${px(3)};opacity:.92;letter-spacing:.04em}
`;
}

/** Catalogue given to models: what each component is for, its timing and its parameters. */
export function componentCatalog() {
  return motionComponents
    .map(
      (c) =>
        `- ${c.id} (${c.name}) : ${c.description} Durée ${c.timing.minMs}–${c.timing.maxMs} ms. Paramètres : ${JSON.stringify(z.toJSONSchema(c.params))} Style : ${JSON.stringify(z.toJSONSchema(c.style))}`,
    )
    .join("\n");
}
