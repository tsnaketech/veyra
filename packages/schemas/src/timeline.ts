/**
 * Resolve each cue's single anchor at every composition: event anchors follow
 * stable scene ids across revisions; absolute anchors never move. A missing event
 * is an explicit sync error, never an absolute fallback. Anchors cannot be mixed.
 * The composition ends at the last scene event (or last event if no scenes exist;
 * an empty timeline ends at zero). Both boundary times are valid. CFR only;
 * endFrame is the displayed frame at endMs, clamped, not an exclusive frame bound.
 */
import { z } from "zod";
import { idSchema } from "./core";
import { frameAt, type FrameRate } from "./frames";

export const eventNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const timelineEventSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["scene", "animation", "visual", "audio", "comment"]),
    sceneId: idSchema("scn").nullable(),
    name: eventNameSchema,
    index: z.number().int().nonnegative().default(0),
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().nonnegative(),
    source: z.enum(["motion", "audio", "review"]),
  })
  .refine(
    (e) => e.endMs >= e.startMs && e.endFrame >= e.startFrame,
    "Invalid event interval",
  );
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export function createTimelineEvent(
  event: Omit<z.input<typeof timelineEventSchema>, "startFrame" | "endFrame">,
  rate: FrameRate,
  count: number,
): TimelineEvent {
  return timelineEventSchema.parse({
    ...event,
    startFrame: frameAt(event.startMs, rate, count),
    endFrame: frameAt(event.endMs, rate, count),
  });
}
export const anchorSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("absolute"), atMs: z.number().nonnegative() })
    .strict(),
  z
    .object({
      type: z.literal("event"),
      sceneId: idSchema("scn"),
      event: eventNameSchema,
      index: z.number().int().nonnegative().default(0),
      edge: z.enum(["start", "end"]).default("start"),
      offsetMs: z.number().int(),
    })
    .strict(),
]);
export type Anchor = z.infer<typeof anchorSchema>;
export type AnchorResolution =
  | { atMs: number }
  | {
      error: {
        code: "event-missing" | "before-zero" | "after-end";
        message: string;
      };
    };
export function resolveAnchor(
  input: z.input<typeof anchorSchema>,
  events: readonly TimelineEvent[],
): AnchorResolution {
  const anchor = anchorSchema.parse(input);
  let atMs: number;
  if (anchor.type === "absolute") atMs = anchor.atMs;
  else {
    const event = events.find(
      (e) =>
        e.sceneId === anchor.sceneId &&
        e.name === anchor.event &&
        e.index === anchor.index,
    );
    if (!event)
      return {
        error: {
          code: "event-missing",
          message: `Événement absent : ${anchor.sceneId}:${anchor.event}:${anchor.index}`,
        },
      };
    atMs =
      (anchor.edge === "start" ? event.startMs : event.endMs) + anchor.offsetMs;
  }
  if (atMs < 0)
    return {
      error: {
        code: "before-zero",
        message: "Ancrage avant le début de la composition",
      },
    };
  const scenes = events.filter((e) => e.kind === "scene");
  const end = Math.max(
    0,
    ...(scenes.length ? scenes : events).map((e) => e.endMs),
  );
  if (atMs > end)
    return {
      error: {
        code: "after-end",
        message: "Ancrage après la fin de la composition",
      },
    };
  return { atMs };
}
export function assertConstantFrameRate(
  media: { constantFrameRate: boolean } | null | undefined,
): void {
  if (media?.constantFrameRate === false)
    throw new Error("fréquence variable non prise en charge");
}
