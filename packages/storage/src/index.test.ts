import { afterEach, beforeEach, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStorage, safePath } from "./index";
let root: string, storage: ProjectStorage;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "veyra-storage-"));
  storage = new ProjectStorage(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it("creates revision layout and write-once originals", () => {
  expect(storage.ensureRevision("prj_one", "rev_one").composition).toBe(
    join(root, "prj_one/revisions/rev_one/composition"),
  );
  const original = storage.writeOriginal(
    "prj_one",
    "asset.txt",
    Buffer.from("original"),
  );
  expect(() =>
    storage.writeOriginal("prj_one", "asset.txt", Buffer.from("changed")),
  ).toThrow();
  expect(readFileSync(original, "utf8")).toBe("original");
});
it.each([
  "../secret",
  "/tmp/secret",
  "a/../../secret",
  "a\\..\\secret",
  "C:\\secret",
  "a//b",
])("rejects traversal %s", (name) => {
  expect(() => storage.original("prj_one", name)).toThrow();
});
it("rejects invalid ids", () => {
  expect(() => storage.revision("rev_one", "rev_one")).toThrow();
  expect(() => storage.renderPath("prj_one", "rev_one", "../out")).toThrow();
});
it("rejects symlink escapes and broken links", () => {
  symlinkSync(tmpdir(), join(root, "prj_one"));
  expect(() => storage.ensureRevision("prj_one", "rev_one")).toThrow("Symlink");
  symlinkSync("/nonexistent", join(root, "broken"));
  expect(() => safePath(root, "broken")).toThrow("Symlink");
});
it("rejects a replaced originals directory before writing", () => {
  const dir = storage.ensureRevision("prj_one", "rev_one");
  mkdirSync(join(root, "prj_one/assets"), { recursive: true });
  symlinkSync(dir.renders, join(root, "prj_one/assets/originals"));
  expect(() =>
    storage.writeOriginal("prj_one", "test", Buffer.from("x")),
  ).toThrow("Symlink");
});
