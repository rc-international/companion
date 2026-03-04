import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type FileScope = "user" | "project" | "local";

const FILE_SCOPES = new Set<string>(["user", "project", "local"]);

export function isFileScope(scope: string): scope is FileScope {
  return FILE_SCOPES.has(scope);
}

/**
 * Resolve the settings file path for a given scope.
 * - user: ~/.claude/settings.json
 * - project: <repoRoot>/.claude/settings.json
 * - local: <repoRoot>/.claude/settings.local.json
 */
export function settingsPathForScope(scope: FileScope, repoRoot: string): string {
  switch (scope) {
    case "user":
      return join(homedir(), ".claude", "settings.json");
    case "project":
      return join(repoRoot, ".claude", "settings.json");
    case "local":
      return join(repoRoot, ".claude", "settings.local.json");
  }
}

/** Read and parse a settings file, returning {} if missing/invalid. */
export function readSettingsFile(filePath: string): Record<string, unknown> {
  try {
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Write a settings object back to disk. Creates parent dirs if needed. */
export function writeSettingsFile(filePath: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

/**
 * Remove a server by name from mcpServers in the given settings file.
 * Returns true if the server was found and removed, false otherwise.
 */
export function removeServerFromSettings(filePath: string, serverName: string): boolean {
  const settings = readSettingsFile(filePath);
  const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;
  if (!(serverName in mcpServers)) return false;
  delete mcpServers[serverName];
  settings.mcpServers = mcpServers;
  writeSettingsFile(filePath, settings);
  return true;
}

/**
 * Update (or add) a server config in mcpServers in the given settings file.
 */
export function updateServerInSettings(
  filePath: string,
  serverName: string,
  config: Record<string, unknown>,
): void {
  const settings = readSettingsFile(filePath);
  const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;
  mcpServers[serverName] = config;
  settings.mcpServers = mcpServers;
  writeSettingsFile(filePath, settings);
}
