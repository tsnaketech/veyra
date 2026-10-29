import { z } from "zod";
import {
  createTimelineEvent,
  frameCount,
  storyboardSchema,
  type FrameRate,
  type Storyboard,
  type TimelineEvent,
} from "@veyra/schemas";
import { buildComponentScene } from "./index";
import type { BuildContext } from "./registry";

/** Uses the same scene context as compose; milliseconds remain unrounded. */
export function visualTimeline(
  storyboard: Storyboard,
  rate: FrameRate,
  palette: BuildContext["palette"] = {
    violet: "#7c3aed",
    blue: "#2563eb",
    cyan: "#06b6d4",
  },
): TimelineEvent[] {
  const board = storyboardSchema.parse(storyboard);
  const count = frameCount(
    Math.max(0, ...board.scenes.map((s) => s.start + s.duration)),
    rate,
  );
  const events: TimelineEvent[] = [];
  board.scenes.forEach((scene, sceneIndex) => {
    const add = (
      name: string,
      index: number,
      startMs: number,
      endMs: number,
      kind: "scene" | "visual",
    ) =>
      events.push(
        createTimelineEvent(
          {
            id: `${scene.id}:${name}:${index}`,
            sceneId: scene.id,
            name,
            index,
            startMs,
            endMs,
            kind,
            source: "motion",
          },
          rate,
          count,
        ),
      );
    add("scene", 0, scene.start, scene.start + scene.duration, "scene");
    const durationMs = z
      .number()
      .int()
      .min(0)
      .max(1500)
      .default(500)
      .parse(scene.animation.durationMs);
    if (scene.component) {
      const built = buildComponentScene(scene.component, {
        sceneId: `#scene-${sceneIndex}`,
        durationS: scene.duration / 1000,
        entryS: durationMs / 1000,
        width: board.width,
        height: board.height,
        palette,
      });
      for (const e of built.events)
        add(
          e.name,
          e.index,
          scene.start + e.atS * 1000,
          scene.start + e.endS * 1000,
          "visual",
        );
    } else
      add("text-appear", 0, scene.start, scene.start + durationMs, "visual");
  });
  return events.sort((a, b) => a.startMs - b.startMs);
}
