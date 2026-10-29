import { newId, type Storyboard } from "@veyra/schemas";
import {
  getComponent,
  normalizeComponent,
  componentLabel,
} from "@veyra/motion";

/** 20 s SaaS demo using every registered component with its example parameters. */
export function motionDemoStoryboard(): Storyboard {
  const order = [
    ["animated-title", 4000],
    ["feature-cards", 5000],
    ["product-mockup", 4000],
    ["metrics-counter", 4000],
    ["call-to-action", 3000],
  ] as const;
  let start = 0;
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: order.map(([id, duration]) => {
      const component = normalizeComponent({
        id,
        params: getComponent(id).example,
      });
      const scene = {
        id: newId("scn"),
        start,
        duration,
        text: componentLabel(component),
        animation: { enter: "fade", durationMs: 800, easing: "power2.out" },
        component,
      };
      start += duration;
      return scene;
    }),
  };
}
