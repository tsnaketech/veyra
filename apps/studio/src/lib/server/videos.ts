/**
 * Video identity within a project (D027): independent videos share the project, and a new
 * video's parent link only records the previous head. Used by approval and the render runner.
 */
/** What identity needs from a revision (D027). */
type Lineage = {
  id: string;
  parentRevisionId: string | null;
  resolvedConfig: Record<string, unknown>;
};
/**
 * A revision that starts a video: no parent, or the composition of a new prompt (production
 * run), whose parent link only records the project's previous head. Re-renders and automatic
 * fixes copy the prompt but mark themselves; edits (plans, Director, audio) carry no prompt.
 * shortcut: video identity is derived from `origin`, not stored; a `videoId` column is the
 * upgrade if a new revision path ever copies `prompt` without such a mark (see DECISIONS D027).
 */
export function startsVideo(r: Lineage) {
  const origin = (r.resolvedConfig.origin ?? {}) as Record<string, unknown>;
  return (
    !r.parentRevisionId ||
    (typeof origin.prompt === 'string' &&
      origin.autoFix === undefined &&
      origin.renderRetry === undefined)
  );
}
/** The first revision of the video `id` belongs to, within one project's revisions. */
export function videoOf(revisions: Lineage[], id: string) {
  const byId = new Map(revisions.map((r) => [r.id, r]));
  let r = byId.get(id);
  if (!r) throw new Error('Révision introuvable');
  for (const seen = new Set<string>(); !startsVideo(r) && !seen.has(r.id);) {
    seen.add(r.id);
    const parent = byId.get(r.parentRevisionId!);
    if (!parent) break;
    r = parent;
  }
  return r.id;
}
/** The other revisions of the same video as `id` (same project's revisions given). */
export function otherVersions<R extends Lineage>(revisions: R[], id: string) {
  const video = videoOf(revisions, id);
  return revisions.filter((r) => r.id !== id && videoOf(revisions, r.id) === video);
}
