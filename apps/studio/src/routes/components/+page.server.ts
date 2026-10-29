import { z } from 'zod';
import { motionComponents, registryVersion } from '@veyra/motion';
import type { PageServerLoad } from './$types';

type Manifest = {
  engine: string;
  generatedAt: string;
  previews: {
    id: string;
    image: string;
    frameAtSeconds: number;
    renderSeconds: number;
    check: { ok: boolean; errors: string[]; warnings: string[] };
  }[];
};
// Written by `pnpm motion:previews` (real HyperFrames renders); absent until generated.
const manifests = import.meta.glob<Manifest>('/static/motion-previews/index.json', {
  eager: true,
  import: 'default'
});

/** Parameter fields as displayed: name, type and limits, from each component's Zod schema. */
function fields(schema: z.ZodType) {
  const json = z.toJSONSchema(schema) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, prop]) => ({
    name,
    required: json.required?.includes(name) ?? false,
    type: String(prop.type ?? (prop.enum ? 'enum' : '')),
    detail: [
      prop.maxLength ? `≤ ${prop.maxLength} car.` : '',
      prop.minItems !== undefined ? `${prop.minItems}–${prop.maxItems} éléments` : '',
      prop.enum ? (prop.enum as string[]).join(' | ') : ''
    ]
      .filter(Boolean)
      .join(' · ')
  }));
}

export const load: PageServerLoad = () => {
  const manifest = Object.values(manifests)[0] ?? null;
  return {
    registryVersion,
    manifest: manifest && { engine: manifest.engine, generatedAt: manifest.generatedAt },
    components: motionComponents.map((c) => ({
      id: c.id,
      name: c.name,
      version: c.version,
      description: c.description,
      capabilities: [...c.capabilities],
      timing: c.timing,
      primaryField: c.primaryField,
      params: fields(c.params),
      style: fields(c.style),
      example: JSON.stringify(c.example, null, 2),
      preview: manifest?.previews.find((p) => p.id === c.id) ?? null
    }))
  };
};
