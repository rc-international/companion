import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import {
  isFileScope,
  settingsPathForScope,
  readSettingsFile,
  writeSettingsFile,
  removeServerFromSettings,
  updateServerInSettings,
} from "./claude-settings.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "claude-settings-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("isFileScope", () => {
  it("returns true for user, project, local", () => {
    expect(isFileScope("user")).toBe(true);
    expect(isFileScope("project")).toBe(true);
    expect(isFileScope("local")).toBe(true);
  });

  it("returns false for managed, claudeai, unknown", () => {
    expect(isFileScope("managed")).toBe(false);
    expect(isFileScope("claudeai")).toBe(false);
    expect(isFileScope("unknown")).toBe(false);
  });
});

describe("settingsPathForScope", () => {
  it("returns correct path for project scope", () => {
    expect(settingsPathForScope("project", "/repo")).toBe("/repo/.claude/settings.json");
  });

  it("returns correct path for local scope", () => {
    expect(settingsPathForScope("local", "/repo")).toBe("/repo/.claude/settings.local.json");
  });
});

describe("readSettingsFile", () => {
  it("returns {} for missing file", () => {
    expect(readSettingsFile(join(tempDir, "nonexistent.json"))).toEqual({});
  });

  it("returns {} for invalid JSON", () => {
    const p = join(tempDir, "bad.json");
    writeFileSync(p, "not json", "utf-8");
    expect(readSettingsFile(p)).toEqual({});
  });

  it("parses valid JSON", () => {
    const p = join(tempDir, "ok.json");
    writeFileSync(p, '{"foo": 1}', "utf-8");
    expect(readSettingsFile(p)).toEqual({ foo: 1 });
  });
});

describe("writeSettingsFile", () => {
  it("creates parent directories and writes JSON", () => {
    const p = join(tempDir, "sub", "dir", "settings.json");
    writeSettingsFile(p, { hello: "world" });
    const content = JSON.parse(readFileSync(p, "utf-8"));
    expect(content).toEqual({ hello: "world" });
  });
});

describe("removeServerFromSettings", () => {
  it("removes existing server and returns true", () => {
    const p = join(tempDir, "settings.json");
    writeFileSync(p, JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "y" } } }), "utf-8");
    const result = removeServerFromSettings(p, "a");
    expect(result).toBe(true);
    const content = JSON.parse(readFileSync(p, "utf-8"));
    expect(content.mcpServers).toEqual({ b: { command: "y" } });
  });

  it("returns false if server not found", () => {
    const p = join(tempDir, "settings.json");
    writeFileSync(p, JSON.stringify({ mcpServers: { a: {} } }), "utf-8");
    expect(removeServerFromSettings(p, "nonexistent")).toBe(false);
  });

  it("handles missing file gracefully", () => {
    const p = join(tempDir, "missing.json");
    expect(removeServerFromSettings(p, "foo")).toBe(false);
  });
});

describe("updateServerInSettings", () => {
  it("adds new server to existing file", () => {
    const p = join(tempDir, "settings.json");
    writeFileSync(p, JSON.stringify({ mcpServers: { a: { command: "x" } } }), "utf-8");
    updateServerInSettings(p, "b", { command: "y", args: ["--flag"] });
    const content = JSON.parse(readFileSync(p, "utf-8"));
    expect(content.mcpServers.b).toEqual({ command: "y", args: ["--flag"] });
    expect(content.mcpServers.a).toEqual({ command: "x" });
  });

  it("updates existing server", () => {
    const p = join(tempDir, "settings.json");
    writeFileSync(p, JSON.stringify({ mcpServers: { a: { command: "old" } } }), "utf-8");
    updateServerInSettings(p, "a", { command: "new" });
    const content = JSON.parse(readFileSync(p, "utf-8"));
    expect(content.mcpServers.a).toEqual({ command: "new" });
  });

  it("creates mcpServers key if missing", () => {
    const p = join(tempDir, "settings.json");
    writeFileSync(p, JSON.stringify({ otherKey: true }), "utf-8");
    updateServerInSettings(p, "a", { command: "x" });
    const content = JSON.parse(readFileSync(p, "utf-8"));
    expect(content.mcpServers).toEqual({ a: { command: "x" } });
    expect(content.otherKey).toBe(true);
  });
});
