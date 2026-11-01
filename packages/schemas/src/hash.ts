// Server-only (node:crypto): kept out of the main entry so client bundles stay clean.
import { createHash } from "node:crypto";
import { z } from "zod";

/** JSON values only: reject lossy inputs rather than hash an ambiguous encoding. */
export function inputHash(value: unknown): string {
  const json = z.json().parse(value);
  const stable = (v: z.infer<ReturnType<typeof z.json>>): string => {
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    if (v !== null && typeof v === "object")
      return `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
        .join(",")}}`;
    return JSON.stringify(v);
  };
  return createHash("sha256").update(stable(json)).digest("hex");
}
