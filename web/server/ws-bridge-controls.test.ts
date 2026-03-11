import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

const mockSettingsPathForScope = vi.hoisted(() => vi.fn());
const mockRemoveServerFromSettings = vi.hoisted(() => vi.fn());
const mockUpdateServerInSettings = vi.hoisted(() => vi.fn());

vi.mock("./claude-settings.js", () => ({
  isFileScope: (scope: string) => ["user", "project", "local"].includes(scope),
  settingsPathForScope: mockSettingsPathForScope,
  removeServerFromSettings: mockRemoveServerFromSettings,
  updateServerInSettings: mockUpdateServerInSettings,
}));

import {
  handleMcpAddServer,
  handleMcpRemoveServer,
  handleMcpEditServer,
  handleMcpGetStatus,
} from "./ws-bridge-controls.js";
import type { Session } from "./ws-bridge-types.js";
import type { McpServerDetail } from "./session-types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMcpServer(
  name: string,
  scope: string,
  status: McpServerDetail["status"] = "connected",
): McpServerDetail {
  return {
    name,
    scope,
    status,
    config: { type: "stdio", command: "test-cmd" },
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session-id",
    backendType: "claude",
    cliSocket: null,
    codexAdapter: null,
    browserSockets: new Set(),
    state: {
      session_id: "test-session-id",
      backend_type: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/test",
      repo_root: "/test/repo",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      output_style: "normal",
    } as any,
    pendingPermissions: new Map(),
    pendingControlRequests: new Map(),
    messageHistory: [],
    pendingMessages: [],
    nextEventSeq: 0,
    eventBuffer: [],
    lastAckSeq: -1,
    processedClientMessageIds: [],
    processedClientMessageIdSet: new Set(),
    lastMcpServers: [],
    ...overrides,
  } as Session;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockSettingsPathForScope.mockImplementation((scope: string, repoRoot: string) => {
    switch (scope) {
      case "user":
        return "/home/testuser/.claude/settings.json";
      case "project":
        return `${repoRoot}/.claude/settings.json`;
      case "local":
        return `${repoRoot}/.claude/settings.local.json`;
      default:
        return "/home/testuser/.claude/settings.json";
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── handleMcpAddServer ─────────────────────────────────────────────────────

describe("handleMcpAddServer", () => {
  it("writes the server config to user-scope settings file", () => {
    // Validates that addServer always writes to user settings (~/.claude/settings.json),
    // matching the behavior of `claude mcp add`.
    const session = makeSession();
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();
    const config = { command: "npx", args: ["-y", "my-server"] };

    handleMcpAddServer(session, "my-server", config, sendControlRequestFn, refreshStatus);

    expect(mockSettingsPathForScope).toHaveBeenCalledWith("user", "");
    expect(mockUpdateServerInSettings).toHaveBeenCalledWith(
      "/home/testuser/.claude/settings.json",
      "my-server",
      config,
    );
  });

  it("sends mcp_reconnect control request so CLI picks up new config", () => {
    // Validates that after writing the settings file, a reconnect request is sent
    // to the CLI so it loads the new server without restarting.
    const session = makeSession();
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpAddServer(session, "my-server", { command: "test" }, sendControlRequestFn, refreshStatus);

    expect(sendControlRequestFn).toHaveBeenCalledWith({
      subtype: "mcp_reconnect",
      serverName: "my-server",
    });
  });

  it("calls refreshStatus after 1000ms timeout", () => {
    // Validates that the MCP status is refreshed after a delay to allow
    // the CLI time to process the reconnect before we query status.
    const session = makeSession();
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpAddServer(session, "my-server", { command: "test" }, sendControlRequestFn, refreshStatus);

    expect(refreshStatus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(refreshStatus).toHaveBeenCalledOnce();
  });
});

// ─── handleMcpRemoveServer ──────────────────────────────────────────────────

describe("handleMcpRemoveServer", () => {
  it("removes from project settings when server scope is 'project'", () => {
    // Validates that file-scoped servers (project) are removed from the
    // correct project-level settings file using the session's repo_root.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("proj-server", "project")],
    });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpRemoveServer(session, "proj-server", sendControlRequestFn, refreshStatus);

    expect(mockSettingsPathForScope).toHaveBeenCalledWith("project", "/test/repo");
    expect(mockRemoveServerFromSettings).toHaveBeenCalledWith(
      "/test/repo/.claude/settings.json",
      "proj-server",
    );
  });

  it("removes from user settings when server scope is 'user'", () => {
    // Validates that file-scoped servers (user) are removed from user settings.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("user-server", "user")],
    });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpRemoveServer(session, "user-server", sendControlRequestFn, refreshStatus);

    expect(mockSettingsPathForScope).toHaveBeenCalledWith("user", "/test/repo");
    expect(mockRemoveServerFromSettings).toHaveBeenCalledWith(
      "/home/testuser/.claude/settings.json",
      "user-server",
    );
  });

  it("removes from local settings when server scope is 'local'", () => {
    // Validates that file-scoped servers (local) are removed from local settings file.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("local-server", "local")],
    });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpRemoveServer(session, "local-server", sendControlRequestFn, refreshStatus);

    expect(mockSettingsPathForScope).toHaveBeenCalledWith("local", "/test/repo");
    expect(mockRemoveServerFromSettings).toHaveBeenCalledWith(
      "/test/repo/.claude/settings.local.json",
      "local-server",
    );
  });

  it("falls back to user settings when server scope is 'managed'", () => {
    // Validates that non-file scopes (e.g. "managed") fall back to removing
    // from user settings since the source file isn't directly editable.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("managed-server", "managed")],
    });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpRemoveServer(session, "managed-server", sendControlRequestFn, refreshStatus);

    expect(mockSettingsPathForScope).toHaveBeenCalledWith("user", "");
    expect(mockRemoveServerFromSettings).toHaveBeenCalledWith(
      "/home/testuser/.claude/settings.json",
      "managed-server",
    );
  });

  it("falls back to user settings when server is not found in cache", () => {
    // Validates that if the server isn't in lastMcpServers (scope unknown),
    // we still attempt removal from user settings as a best-effort fallback.
    const session = makeSession({ lastMcpServers: [] });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpRemoveServer(session, "unknown-server", sendControlRequestFn, refreshStatus);

    expect(mockSettingsPathForScope).toHaveBeenCalledWith("user", "");
    expect(mockRemoveServerFromSettings).toHaveBeenCalledWith(
      "/home/testuser/.claude/settings.json",
      "unknown-server",
    );
  });

  it("sends mcp_toggle with enabled: false to disable in running session", () => {
    // Validates that after removing from settings, the server is also
    // immediately disabled in the running CLI session via mcp_toggle.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("my-server", "user")],
    });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpRemoveServer(session, "my-server", sendControlRequestFn, refreshStatus);

    expect(sendControlRequestFn).toHaveBeenCalledWith({
      subtype: "mcp_toggle",
      serverName: "my-server",
      enabled: false,
    });
  });

  it("calls refreshStatus after 500ms timeout", () => {
    // Validates the shorter 500ms delay for remove (vs 1000ms for add/edit),
    // since toggle is faster than reconnect.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("my-server", "user")],
    });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpRemoveServer(session, "my-server", sendControlRequestFn, refreshStatus);

    expect(refreshStatus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(499);
    expect(refreshStatus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refreshStatus).toHaveBeenCalledOnce();
  });

  it("uses cwd as fallback when repo_root is not set", () => {
    // Validates that session.state.cwd is used when repo_root is empty/undefined,
    // which can happen for sessions outside a git repository.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("proj-server", "project")],
    });
    session.state.repo_root = undefined as any;
    session.state.cwd = "/fallback/cwd";
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpRemoveServer(session, "proj-server", sendControlRequestFn, refreshStatus);

    expect(mockSettingsPathForScope).toHaveBeenCalledWith("project", "/fallback/cwd");
  });

  it("logs a warning when removeServerFromSettings returns false", () => {
    // Validates that a console.warn is emitted when the server wasn't found
    // in the settings file (e.g. already removed or wrong file).
    const session = makeSession({
      lastMcpServers: [makeMcpServer("ghost-server", "project")],
    });
    mockRemoveServerFromSettings.mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpRemoveServer(session, "ghost-server", sendControlRequestFn, refreshStatus);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Server "ghost-server" not found'),
    );
    warnSpy.mockRestore();
  });
});

// ─── handleMcpEditServer ────────────────────────────────────────────────────

describe("handleMcpEditServer", () => {
  it("updates project settings when server scope is 'project'", () => {
    // Validates that file-scoped servers are updated in the correct settings file
    // based on their scope, preserving the original config location.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("proj-server", "project")],
    });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();
    const newConfig = { command: "updated-cmd", args: ["--new-flag"] };

    handleMcpEditServer(session, "proj-server", newConfig, sendControlRequestFn, refreshStatus);

    expect(mockSettingsPathForScope).toHaveBeenCalledWith("project", "/test/repo");
    expect(mockUpdateServerInSettings).toHaveBeenCalledWith(
      "/test/repo/.claude/settings.json",
      "proj-server",
      newConfig,
    );
  });

  it("updates user settings when server scope is 'user'", () => {
    // Validates editing a user-scoped server writes to user settings file.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("user-server", "user")],
    });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();
    const newConfig = { command: "updated" };

    handleMcpEditServer(session, "user-server", newConfig, sendControlRequestFn, refreshStatus);

    expect(mockSettingsPathForScope).toHaveBeenCalledWith("user", "/test/repo");
    expect(mockUpdateServerInSettings).toHaveBeenCalledWith(
      "/home/testuser/.claude/settings.json",
      "user-server",
      newConfig,
    );
  });

  it("updates local settings when server scope is 'local'", () => {
    // Validates editing a local-scoped server writes to settings.local.json.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("local-server", "local")],
    });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();
    const newConfig = { command: "local-updated" };

    handleMcpEditServer(session, "local-server", newConfig, sendControlRequestFn, refreshStatus);

    expect(mockSettingsPathForScope).toHaveBeenCalledWith("local", "/test/repo");
    expect(mockUpdateServerInSettings).toHaveBeenCalledWith(
      "/test/repo/.claude/settings.local.json",
      "local-server",
      newConfig,
    );
  });

  it("falls back to user settings when server scope is 'managed'", () => {
    // Validates that non-file scopes (managed) fall back to user settings,
    // since managed servers don't have a directly editable settings file.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("managed-server", "managed")],
    });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();
    const newConfig = { command: "managed-update" };

    handleMcpEditServer(session, "managed-server", newConfig, sendControlRequestFn, refreshStatus);

    expect(mockSettingsPathForScope).toHaveBeenCalledWith("user", "");
    expect(mockUpdateServerInSettings).toHaveBeenCalledWith(
      "/home/testuser/.claude/settings.json",
      "managed-server",
      newConfig,
    );
  });

  it("falls back to user settings when server is not found in cache", () => {
    // Validates that unknown servers (not in lastMcpServers) get written
    // to user settings as a best-effort fallback.
    const session = makeSession({ lastMcpServers: [] });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();
    const newConfig = { command: "new-config" };

    handleMcpEditServer(session, "unknown-server", newConfig, sendControlRequestFn, refreshStatus);

    expect(mockSettingsPathForScope).toHaveBeenCalledWith("user", "");
    expect(mockUpdateServerInSettings).toHaveBeenCalledWith(
      "/home/testuser/.claude/settings.json",
      "unknown-server",
      newConfig,
    );
  });

  it("sends mcp_reconnect control request to reload config", () => {
    // Validates that after updating settings, a reconnect is sent so
    // the CLI reloads the server with the new configuration.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("my-server", "user")],
    });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpEditServer(session, "my-server", { command: "test" }, sendControlRequestFn, refreshStatus);

    expect(sendControlRequestFn).toHaveBeenCalledWith({
      subtype: "mcp_reconnect",
      serverName: "my-server",
    });
  });

  it("calls refreshStatus after 1000ms timeout", () => {
    // Validates the 1000ms delay before refresh, giving the CLI time
    // to reconnect the server with updated config.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("my-server", "user")],
    });
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpEditServer(session, "my-server", { command: "test" }, sendControlRequestFn, refreshStatus);

    expect(refreshStatus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(refreshStatus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refreshStatus).toHaveBeenCalledOnce();
  });

  it("uses cwd as fallback when repo_root is not set", () => {
    // Validates cwd fallback for sessions outside a git repo.
    const session = makeSession({
      lastMcpServers: [makeMcpServer("local-server", "local")],
    });
    session.state.repo_root = undefined as any;
    session.state.cwd = "/other/path";
    const sendControlRequestFn = vi.fn();
    const refreshStatus = vi.fn();

    handleMcpEditServer(session, "local-server", { command: "x" }, sendControlRequestFn, refreshStatus);

    expect(mockSettingsPathForScope).toHaveBeenCalledWith("local", "/other/path");
  });
});

// ─── handleMcpGetStatus ─────────────────────────────────────────────────────

describe("handleMcpGetStatus", () => {
  it("sends mcp_status control request with response handler", () => {
    // Validates that handleMcpGetStatus sends the correct control request
    // and registers a response handler for the mcp_status subtype.
    const session = makeSession();
    const sendControlRequestFn = vi.fn();
    const broadcastToBrowsers = vi.fn();

    handleMcpGetStatus(session, sendControlRequestFn, broadcastToBrowsers);

    expect(sendControlRequestFn).toHaveBeenCalledWith(
      { subtype: "mcp_status" },
      expect.objectContaining({
        subtype: "mcp_status",
        resolve: expect.any(Function),
      }),
    );
  });

  it("caches servers in session.lastMcpServers when response arrives", () => {
    // Validates that the response handler extracts mcpServers from the
    // CLI response and stores them on the session for later use by
    // remove/edit operations that need to look up server scope.
    const session = makeSession();
    const sendControlRequestFn = vi.fn();
    const broadcastToBrowsers = vi.fn();

    handleMcpGetStatus(session, sendControlRequestFn, broadcastToBrowsers);

    // Extract and invoke the resolve callback
    const onResponse = sendControlRequestFn.mock.calls[0][1];
    const servers = [
      makeMcpServer("server-a", "user"),
      makeMcpServer("server-b", "project"),
    ];
    onResponse.resolve({ mcpServers: servers });

    expect(session.lastMcpServers).toEqual(servers);
  });

  it("broadcasts mcp_status message to browsers when response arrives", () => {
    // Validates that the server list is forwarded to all connected browsers
    // so the UI can display the current MCP server status.
    const session = makeSession();
    const sendControlRequestFn = vi.fn();
    const broadcastToBrowsers = vi.fn();

    handleMcpGetStatus(session, sendControlRequestFn, broadcastToBrowsers);

    const onResponse = sendControlRequestFn.mock.calls[0][1];
    const servers = [makeMcpServer("server-a", "user")];
    onResponse.resolve({ mcpServers: servers });

    expect(broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "mcp_status",
      servers,
    });
  });

  it("defaults to empty array when response has no mcpServers", () => {
    // Validates graceful handling when the CLI response doesn't include
    // the mcpServers field (e.g. older CLI version or error response).
    const session = makeSession();
    const sendControlRequestFn = vi.fn();
    const broadcastToBrowsers = vi.fn();

    handleMcpGetStatus(session, sendControlRequestFn, broadcastToBrowsers);

    const onResponse = sendControlRequestFn.mock.calls[0][1];
    onResponse.resolve({});

    expect(session.lastMcpServers).toEqual([]);
    expect(broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "mcp_status",
      servers: [],
    });
  });
});
