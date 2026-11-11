import { z } from "zod";

export const idPrefixes = [
  "prj",
  "scn",
  "ast",
  "cnv",
  "msg",
  "rev",
  "rnd",
  "fdb",
  "qar",
  "qck",
  "qis",
  "pln",
  "cbt",
  "tsk",
  "qev",
  "atr",
  "run",
  "phs",
  "cap",
  "cue",
  "tcl",
  "stp",
] as const;
export type IdPrefix = (typeof idPrefixes)[number];
export function newId<P extends IdPrefix>(prefix: P): `${P}_${string}` {
  return `${prefix}_${crypto.randomUUID()}`;
}
export const idSchema = (prefix: IdPrefix) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9-]+$`));
