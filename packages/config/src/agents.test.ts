// Checks the Claude Code development sub-agents (.agents/agents, linked from .claude/agents).
// Claude Code silently skips files with bad frontmatter and ignores unknown keys, so this
// test is the only guard against a definition that quietly stops loading.
import { describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const repo = resolve(__dirname, "../../..");
const dir = join(repo, ".agents/agents");
const skillsDir = join(repo, ".agents/skills");
// Documented frontmatter fields (code.claude.com/docs/en/sub-agents, read 2026-11-03).
const known = new Set([
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "permissionMode",
  "skills",
  "memory",
  "color",
  "hooks",
  "mcpServers",
  "maxTurns",
  "background",
  "effort",
  "isolation",
  "initialPrompt",
  "omitClaudeMd",
  "autoCompactWindow",
  "experimental",
]);
const builtinTools = new Set([
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Skill",
  "ToolSearch",
  "LSP",
  "Monitor",
  "TaskStop",
  "SendMessage",
]);
const list = (value: unknown) =>
  Array.isArray(value)
    ? value.map(String)
    : String(value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
const agents = files.map((file) => {
  const source = readFileSync(join(dir, file), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  return {
    file,
    meta: parse(match[1]) as Record<string, unknown>,
    body: match[2],
  };
});

describe("Claude Code development sub-agents", () => {
  it("are exposed to Claude Code through the .claude/agents link", () => {
    const link = join(repo, ".claude/agents");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("../.agents/agents");
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(agents.map((a) => [a.file, a] as const))(
    "%s is a valid definition",
    (file, a) => {
      for (const key of Object.keys(a.meta))
        expect(known, `${file}: unknown key ${key}`).toContain(key);
      expect(a.meta.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(file).toBe(`${a.meta.name}.md`);
      expect(String(a.meta.description ?? "").length).toBeGreaterThan(40);
      expect(a.body.trim().length).toBeGreaterThan(200);
      for (const tool of [
        ...list(a.meta.tools),
        ...list(a.meta.disallowedTools),
      ])
        expect(builtinTools, `${file}: tool ${tool}`).toContain(tool);
      for (const skill of list(a.meta.skills))
        expect(
          existsSync(join(skillsDir, skill, "SKILL.md")),
          `${file}: skill ${skill}`,
        ).toBe(true);
      // Never widen permissions from a definition file.
      expect(a.meta.permissionMode).toBeUndefined();
      // Shared rules live in AGENTS.md (loaded by every sub-agent); bodies point to it.
      expect(a.body).toContain("AGENTS.md");
    },
  );

  it("keeps reviewers and researchers from editing the repository", () => {
    const byName = new Map(agents.map((a) => [a.meta.name, a.meta]));
    for (const name of [
      "security-reviewer",
      "independent-reviewer",
      "research-analyst",
    ])
      expect(list(byName.get(name)?.disallowedTools)).toContain("Edit");
    expect(list(byName.get("security-reviewer")?.tools)).not.toContain("Write");
    expect(list(byName.get("research-analyst")?.tools)).not.toContain("Bash");
  });

  it("has unique names", () => {
    const names = agents.map((a) => a.meta.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
