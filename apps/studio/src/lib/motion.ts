import { getComponent, type ComponentId } from '@veyra/motion';
import type { SceneComponent } from '@veyra/schemas';

/** Short, human-readable values of a component's parameters for the Studio panels. */
export function summarizeParams(component: SceneComponent): { key: string; value: string }[] {
  const show = (value: unknown): string =>
    Array.isArray(value)
      ? `${value.length} élément(s) : ${value
          .map((item) =>
            typeof item === 'object' && item
              ? String(Object.values(item as Record<string, unknown>)[0])
              : String(item)
          )
          .join(', ')}`
      : String(value);
  return Object.entries(component.params).map(([key, value]) => ({
    key,
    value: show(value).slice(0, 120)
  }));
}
export const componentName = (id: string) => {
  try {
    return getComponent(id as ComponentId).name;
  } catch {
    return id;
  }
};
