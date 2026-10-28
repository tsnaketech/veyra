import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class UnsafePathError extends Error {}
export function validateId(
  id: string,
  prefix: "prj" | "rev" | "rnd" | "fdb" | "tsk",
): string {
  if (!new RegExp(`^${prefix}_[A-Za-z0-9-]+$`).test(id))
    throw new UnsafePathError(`Invalid ${prefix} id`);
  return id;
}
function segments(value: string): void {
  if (
    !value ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => !part || part === ".." || part === ".")
  ) {
    throw new UnsafePathError("Unsafe relative path");
  }
}
// Recheck before each IO operation; callers must not share writable roots with untrusted processes.
export function safePath(root: string, ...parts: string[]): string {
  parts.forEach(segments);
  const canonical = realpathSync(root);
  let current = canonical;
  for (const part of parts.flatMap((part) => part.split("/"))) {
    current = resolve(current, part);
    if (
      existsSync(current) ||
      (() => {
        try {
          lstatSync(current);
          return true;
        } catch {
          return false;
        }
      })()
    ) {
      if (lstatSync(current).isSymbolicLink())
        throw new UnsafePathError("Symlink path refused");
      const actual = realpathSync(current);
      const rel = relative(canonical, actual);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new UnsafePathError("Path escapes workspace");
    }
  }
  return current;
}
export class ProjectStorage {
  readonly root: string;
  constructor(
    root = fileURLToPath(new URL("../../../projects", import.meta.url)),
  ) {
    const configured = resolve(root);
    if (existsSync(configured) && lstatSync(configured).isSymbolicLink())
      throw new UnsafePathError("Symlink root refused");
    mkdirSync(configured, { recursive: true });
    this.root = realpathSync(root);
  }
  project(projectId: string): string {
    return safePath(this.root, validateId(projectId, "prj"));
  }
  revision(projectId: string, revisionId: string): string {
    return safePath(
      this.root,
      validateId(projectId, "prj"),
      "revisions",
      validateId(revisionId, "rev"),
    );
  }
  ensureRevision(projectId: string, revisionId: string) {
    const revision = this.revision(projectId, revisionId);
    mkdirSync(revision, { recursive: true });
    for (const name of ["composition", "renders"])
      mkdirSync(safePath(revision, name), { recursive: true });
    return {
      revision,
      composition: safePath(revision, "composition"),
      renders: safePath(revision, "renders"),
    };
  }
  original(projectId: string, name: string): string {
    return safePath(
      this.root,
      validateId(projectId, "prj"),
      "assets/originals",
      name,
    );
  }
  writeOriginal(projectId: string, name: string, data: Uint8Array): string {
    const path = this.original(projectId, name);
    mkdirSync(dirname(path), { recursive: true });
    const checked = this.original(projectId, name);
    const fd = openSync(
      checked,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
    return checked;
  }
  /** PNG of the exact frame a comment points at. */
  annotationPath(
    projectId: string,
    revisionId: string,
    feedbackId: string,
  ): string {
    const { revision } = this.ensureRevision(projectId, revisionId);
    mkdirSync(safePath(revision, "annotations"), { recursive: true });
    return safePath(
      revision,
      "annotations",
      `${validateId(feedbackId, "fdb")}.png`,
    );
  }
  /** Exchange folder of an assisted AI task (request.json in, result.json back). */
  taskDir(projectId: string, taskId: string): string {
    const dir = safePath(
      this.root,
      validateId(projectId, "prj"),
      "ai-tasks",
      validateId(taskId, "tsk"),
    );
    mkdirSync(dir, { recursive: true });
    // Re-check after creation: nothing on the way may be a symlink.
    return safePath(
      this.root,
      validateId(projectId, "prj"),
      "ai-tasks",
      taskId,
    );
  }
  renderPath(projectId: string, revisionId: string, jobId: string): string {
    const { renders } = this.ensureRevision(projectId, revisionId);
    return safePath(renders, `${validateId(jobId, "rnd")}.mp4`);
  }
}
