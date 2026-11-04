import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess, ProcessError } from "@veyra/video";
import { Sandbox, SandboxUnavailableError } from "./sandbox";
vi.mock("@veyra/video", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@veyra/video")>()),
  runProcess: vi.fn(),
}));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "veyra-sandbox-"));
  vi.mocked(runProcess)
    .mockReset()
    .mockResolvedValue({ stdout: "", stderr: "" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it("refuses a missing sandbox without spawning", async () => {
  await expect(
    new Sandbox({ bwrapPath: "/missing-bwrap" }).run("test", [], root, root),
  ).rejects.toBeInstanceOf(SandboxUnavailableError);
  expect(runProcess).not.toHaveBeenCalled();
});
it("wraps array arguments with network isolation and resource limits", async () => {
  await new Sandbox({ bwrapPath: "/usr/bin/true" }).run(
    "/bin/example",
    ["render", "a;echo evil"],
    root,
    root,
  );
  const [command, args, options] = vi.mocked(runProcess).mock.calls[0];
  expect(command).toBe("/usr/bin/prlimit");
  expect(args).toContain("--unshare-net");
  expect(args).toContain("--unshare-pid");
  for (const flag of [
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--new-session",
    "--die-with-parent",
  ])
    expect(args).toContain(flag);
  // /run is masked right after the read-only root, before any writable bind.
  expect(
    args.slice(args.indexOf("--ro-bind"), args.indexOf("--ro-bind") + 5),
  ).toEqual(["--ro-bind", "/", "/", "--tmpfs", "/run"]);
  expect(args).toContain("--cpu=90");
  expect(args.slice(-3)).toEqual(["/bin/example", "render", "a;echo evil"]);
  expect(args.filter((arg) => arg === "--bind")).toHaveLength(1);
  expect(options?.env?.HYPERFRAMES_TELEMETRY).toBe("0");
  expect(options?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
});
it("permits explicit opt-in fallback only for missing bwrap", async () => {
  await new Sandbox({
    bwrapPath: "/missing-bwrap",
    allowUnsandboxed: true,
  }).run("/bin/example", ["render"], root, root);
  expect(vi.mocked(runProcess).mock.calls[0][1]).not.toContain("--unshare-net");
});
it("refuses namespace failures without retrying unsandboxed", async () => {
  vi.mocked(runProcess).mockRejectedValue(
    new ProcessError(
      "Exit 1",
      "bwrap: Creating new namespace failed: Operation not permitted",
    ),
  );
  await expect(
    new Sandbox({ bwrapPath: "/usr/bin/true", allowUnsandboxed: true }).run(
      "test",
      [],
      root,
      root,
    ),
  ).rejects.toBeInstanceOf(SandboxUnavailableError);
  expect(runProcess).toHaveBeenCalledTimes(1);
});
it("enforces aggregate output size and working-directory confinement", async () => {
  writeFileSync(join(root, "too-big"), "x".repeat(101));
  await expect(
    new Sandbox({ maxOutputBytes: 100 }).run("test", [], root, root),
  ).rejects.toThrow("size limit");
  await expect(new Sandbox().run("test", [], root, tmpdir())).rejects.toThrow(
    "escapes",
  );
  expect(runProcess).not.toHaveBeenCalled();
});
it("monitors growth while a child runs", async () => {
  vi.mocked(runProcess).mockImplementation(async (_command, _args, options) => {
    mkdirSync(join(root, "renders"));
    writeFileSync(join(root, "renders/file"), "x".repeat(101));
    options?.monitor?.();
    return { stdout: "", stderr: "" };
  });
  await expect(
    new Sandbox({ maxOutputBytes: 100, bwrapPath: "/usr/bin/true" }).run(
      "test",
      [],
      root,
      root,
    ),
  ).rejects.toThrow("size limit");
});
