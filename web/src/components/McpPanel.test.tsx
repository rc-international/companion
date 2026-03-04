// @vitest-environment jsdom
/**
 * Tests for the McpSection component (McpPanel.tsx).
 *
 * McpSection displays MCP (Model Context Protocol) servers for a given session,
 * including server status, toggle/reconnect controls, and an add-server form.
 * It auto-fetches MCP status when the CLI is connected.
 *
 * This file merges two test suites:
 * - Upstream suite: broad functional/accessibility coverage using resetStore (session "s1")
 * - Feature suite: scope-gating and file-scope delete/edit tests using mockServers (session "test-session")
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { McpServerDetail } from "../types.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockSendMcpGetStatus = vi.fn();
const mockSendMcpToggle = vi.fn();
const mockSendMcpReconnect = vi.fn();
const mockSendMcpSetServers = vi.fn();
const mockSendMcpDeleteFileServer = vi.fn();
const mockSendMcpEditFileServer = vi.fn();

vi.mock("../ws.js", () => ({
  sendMcpGetStatus: (...args: unknown[]) => mockSendMcpGetStatus(...args),
  sendMcpToggle: (...args: unknown[]) => mockSendMcpToggle(...args),
  sendMcpReconnect: (...args: unknown[]) => mockSendMcpReconnect(...args),
  sendMcpSetServers: (...args: unknown[]) => mockSendMcpSetServers(...args),
  sendMcpDeleteFileServer: (...args: unknown[]) => mockSendMcpDeleteFileServer(...args),
  sendMcpEditFileServer: (...args: unknown[]) => mockSendMcpEditFileServer(...args),
}));

// ─── Store mock ──────────────────────────────────────────────────────────────
//
// The store mock uses a shared MockStoreState object so that both the upstream
// suite's resetStore() pattern (keyed by "s1") and the feature suite's
// mockServers/mockCliConnected variables (keyed by "test-session") can coexist
// in a single vi.mock() call.

interface MockStoreState {
  mcpServers: Map<string, McpServerDetail[]>;
  cliConnected: Map<string, boolean>;
  sessions: Map<string, { mcp_servers?: { name: string; status: string }[] }>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    mcpServers: new Map(),
    cliConnected: new Map([["s1", true]]),
    sessions: new Map([["s1", { mcp_servers: [] }]]),
    ...overrides,
  };
  // Sync convenience variables used by the feature suite
  mockServers = mockState.mcpServers.get("test-session") ?? [];
  mockCliConnected = mockState.cliConnected.get("test-session") ?? true;
}

// Convenience mutable variables for the feature suite's "test-session"
let mockServers: McpServerDetail[] = [];
let mockCliConnected = true;

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(mockState),
    { getState: () => mockState },
  ),
}));

import { McpSection } from "./McpPanel.js";

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset with sensible defaults that satisfy both suites:
  // - "s1" is connected (upstream suite)
  // - "test-session" starts empty/connected (feature suite)
  mockState = {
    mcpServers: new Map(),
    cliConnected: new Map([["s1", true], ["test-session", true]]),
    sessions: new Map([["s1", { mcp_servers: [] }]]),
  };
  mockServers = [];
  mockCliConnected = true;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeServer(overrides: Partial<McpServerDetail> = {}): McpServerDetail {
  return {
    name: "test-server",
    status: "connected",
    config: { type: "stdio", command: "npx", args: ["-y", "mcp-server"] },
    scope: "project",
    tools: [],
    ...overrides,
  };
}

// ─── Upstream suite: McpSection (session "s1") ───────────────────────────────

describe("McpSection", () => {
  it("renders 'MCP Servers' heading", () => {
    // The section header should always be visible regardless of server state
    render(<McpSection sessionId="s1" />);
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
  });

  it("shows empty state when no servers are configured", () => {
    // When no MCP servers exist and the form is not open, show the empty message
    render(<McpSection sessionId="s1" />);
    expect(screen.getByText(/No MCP servers configured/)).toBeInTheDocument();
  });

  it("shows 'Add one' link in empty state when CLI is connected", () => {
    // The empty state should offer a clickable link to add a server
    render(<McpSection sessionId="s1" />);
    expect(screen.getByText("Add one")).toBeInTheDocument();
  });

  it("does not show 'Add one' link in empty state when CLI is disconnected", () => {
    // When disconnected, the add-one shortcut should not appear
    mockState.cliConnected = new Map([["s1", false]]);
    render(<McpSection sessionId="s1" />);
    expect(screen.getByText(/No MCP servers configured/)).toBeInTheDocument();
    expect(screen.queryByText("Add one")).not.toBeInTheDocument();
  });

  it("renders server rows with correct status badges", () => {
    // Each server should display its name and a status label derived from STATUS_STYLES
    const servers = [
      makeServer({ name: "alpha", status: "connected" }),
      makeServer({ name: "beta", status: "failed" }),
      makeServer({ name: "gamma", status: "disabled" }),
    ];
    mockState.mcpServers = new Map([["s1", servers]]);
    render(<McpSection sessionId="s1" />);

    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("gamma")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("shows toggle (disable/enable) buttons on servers", () => {
    // Each server row should have a toggle button to disable or enable
    const servers = [
      makeServer({ name: "enabled-srv", status: "connected" }),
      makeServer({ name: "disabled-srv", status: "disabled" }),
    ];
    mockState.mcpServers = new Map([["s1", servers]]);
    render(<McpSection sessionId="s1" />);

    // Connected server should have a "Disable server" button
    expect(screen.getByTitle("Disable server")).toBeInTheDocument();
    // Disabled server should have an "Enable server" button
    expect(screen.getByTitle("Enable server")).toBeInTheDocument();
  });

  it("calls sendMcpToggle when toggle button is clicked", () => {
    // Clicking the disable button should call sendMcpToggle(sessionId, name, false)
    const servers = [makeServer({ name: "my-server", status: "connected" })];
    mockState.mcpServers = new Map([["s1", servers]]);
    render(<McpSection sessionId="s1" />);

    fireEvent.click(screen.getByTitle("Disable server"));
    expect(mockSendMcpToggle).toHaveBeenCalledWith("s1", "my-server", false);
  });

  it("shows reconnect button for connected and failed servers", () => {
    // Reconnect should appear for "connected" and "failed" statuses (per component logic)
    const servers = [
      makeServer({ name: "ok-srv", status: "connected" }),
      makeServer({ name: "fail-srv", status: "failed" }),
      makeServer({ name: "off-srv", status: "disabled" }),
    ];
    mockState.mcpServers = new Map([["s1", servers]]);
    render(<McpSection sessionId="s1" />);

    // Two reconnect buttons: one for connected, one for failed
    const reconnectButtons = screen.getAllByTitle("Reconnect server");
    expect(reconnectButtons).toHaveLength(2);
  });

  it("calls sendMcpReconnect when reconnect button is clicked", () => {
    // Clicking reconnect should call the correct WS function
    const servers = [makeServer({ name: "fail-srv", status: "failed" })];
    mockState.mcpServers = new Map([["s1", servers]]);
    render(<McpSection sessionId="s1" />);

    fireEvent.click(screen.getByTitle("Reconnect server"));
    expect(mockSendMcpReconnect).toHaveBeenCalledWith("s1", "fail-srv");
  });

  it("does not show reconnect button for disabled or connecting servers", () => {
    // Reconnect should only appear for "connected" and "failed"
    const servers = [
      makeServer({ name: "disabled-srv", status: "disabled" }),
      makeServer({ name: "connecting-srv", status: "connecting" }),
    ];
    mockState.mcpServers = new Map([["s1", servers]]);
    render(<McpSection sessionId="s1" />);

    expect(screen.queryByTitle("Reconnect server")).not.toBeInTheDocument();
  });
});

describe("McpSection add server form", () => {
  it("opens form when add button is clicked", () => {
    // Clicking the add button should reveal the AddServerForm
    render(<McpSection sessionId="s1" />);

    fireEvent.click(screen.getByTitle("Add MCP server"));
    expect(screen.getByText("Server Name")).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
  });

  it("form shows name input, type selector, and command/args fields for stdio", () => {
    // The default form should show stdio-specific fields (Command, Args)
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    expect(screen.getByPlaceholderText("my-mcp-server")).toBeInTheDocument();
    expect(screen.getByText("stdio")).toBeInTheDocument();
    expect(screen.getByText("sse")).toBeInTheDocument();
    expect(screen.getByText("http")).toBeInTheDocument();
    expect(screen.getByText("Command")).toBeInTheDocument();
    expect(screen.getByText(/Args/)).toBeInTheDocument();
  });

  it("form shows URL field when type is changed to sse", () => {
    // Switching type to sse should replace command/args with a URL field
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    // Click the sse type button
    fireEvent.click(screen.getByText("sse"));

    expect(screen.getByText("URL")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("http://localhost:3000/mcp")).toBeInTheDocument();
    // Command and Args should not be visible
    expect(screen.queryByText("Command")).not.toBeInTheDocument();
    expect(screen.queryByText(/Args/)).not.toBeInTheDocument();
  });

  it("form shows URL field when type is changed to http", () => {
    // Switching type to http should also show the URL field
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    fireEvent.click(screen.getByText("http"));

    expect(screen.getByText("URL")).toBeInTheDocument();
    expect(screen.queryByText("Command")).not.toBeInTheDocument();
  });

  it("submit calls sendMcpSetServers with stdio config", () => {
    // Submitting a valid stdio form should call the WS function with correct config
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    fireEvent.change(screen.getByPlaceholderText("my-mcp-server"), {
      target: { value: "my-new-server" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("npx -y @modelcontextprotocol/server-memory"),
      { target: { value: "npx" } },
    );
    fireEvent.change(screen.getByPlaceholderText("--port 3000"), {
      target: { value: "-y @mcp/server" },
    });

    fireEvent.click(screen.getByText("Add Server"));

    expect(mockSendMcpSetServers).toHaveBeenCalledWith("s1", {
      "my-new-server": {
        type: "stdio",
        command: "npx",
        args: ["-y", "@mcp/server"],
      },
    });
  });

  it("submit calls sendMcpSetServers with sse config", () => {
    // Submitting a valid sse form should call with url instead of command
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    fireEvent.change(screen.getByPlaceholderText("my-mcp-server"), {
      target: { value: "remote-server" },
    });
    fireEvent.click(screen.getByText("sse"));
    fireEvent.change(screen.getByPlaceholderText("http://localhost:3000/mcp"), {
      target: { value: "http://example.com/mcp" },
    });

    fireEvent.click(screen.getByText("Add Server"));

    expect(mockSendMcpSetServers).toHaveBeenCalledWith("s1", {
      "remote-server": {
        type: "sse",
        url: "http://example.com/mcp",
      },
    });
  });

  it("submit button is disabled when form is incomplete", () => {
    // With no name or command, the Add Server button should be disabled
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    const submitButton = screen.getByText("Add Server");
    expect(submitButton).toBeDisabled();
  });

  it("cancel button closes the form", () => {
    // Clicking Cancel should hide the form and return to normal view
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    // Form should be visible
    expect(screen.getByText("Server Name")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Cancel"));

    // Form should no longer be visible
    expect(screen.queryByText("Server Name")).not.toBeInTheDocument();
  });

  it("hides empty state when add form is open", () => {
    // When the form is showing, the empty state message should not appear
    render(<McpSection sessionId="s1" />);
    expect(screen.getByText(/No MCP servers configured/)).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Add MCP server"));

    expect(screen.queryByText(/No MCP servers configured/)).not.toBeInTheDocument();
  });
});

describe("McpSection refresh and auto-fetch", () => {
  it("refresh button calls sendMcpGetStatus", () => {
    // Clicking the refresh button should trigger a status fetch
    render(<McpSection sessionId="s1" />);

    // Clear the auto-fetch call that happens on mount
    mockSendMcpGetStatus.mockClear();

    fireEvent.click(screen.getByTitle("Refresh MCP server status"));
    expect(mockSendMcpGetStatus).toHaveBeenCalledWith("s1");
  });

  it("auto-fetches MCP status when CLI is connected (useEffect)", () => {
    // On mount with cliConnected=true, sendMcpGetStatus should be called automatically
    render(<McpSection sessionId="s1" />);
    expect(mockSendMcpGetStatus).toHaveBeenCalledWith("s1");
  });

  it("does not auto-fetch when CLI is disconnected", () => {
    // When cliConnected is false, no automatic status fetch should occur
    mockState.cliConnected = new Map([["s1", false]]);
    render(<McpSection sessionId="s1" />);
    expect(mockSendMcpGetStatus).not.toHaveBeenCalled();
  });
});

describe("McpSection disabled state when not connected", () => {
  it("add button is disabled when CLI is not connected", () => {
    // The add button should be non-interactive when disconnected
    mockState.cliConnected = new Map([["s1", false]]);
    render(<McpSection sessionId="s1" />);

    const addButton = screen.getByTitle("Add MCP server");
    expect(addButton).toBeDisabled();
  });

  it("refresh button is disabled when CLI is not connected", () => {
    // The refresh button should also be disabled when disconnected
    mockState.cliConnected = new Map([["s1", false]]);
    render(<McpSection sessionId="s1" />);

    const refreshButton = screen.getByTitle("Refresh MCP server status");
    expect(refreshButton).toBeDisabled();
  });
});

describe("McpSection fallback from session mcp_servers", () => {
  it("falls back to session mcp_servers when detailed servers are not available", () => {
    // When mcpServers map is empty but session has mcp_servers, use those as fallback
    mockState.sessions = new Map([
      ["s1", { mcp_servers: [{ name: "fallback-srv", status: "connected" }] }],
    ]);
    render(<McpSection sessionId="s1" />);

    expect(screen.getByText("fallback-srv")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });
});

describe("McpSection server row expansion", () => {
  it("expands to show config details when server name is clicked", () => {
    // Clicking a server name should expand to show type, command, scope, etc.
    const servers = [
      makeServer({
        name: "detail-srv",
        status: "connected",
        config: { type: "stdio", command: "npx", args: ["-y", "mcp-tool"] },
        scope: "project",
      }),
    ];
    mockState.mcpServers = new Map([["s1", servers]]);
    render(<McpSection sessionId="s1" />);

    // Click the server name to expand
    fireEvent.click(screen.getByText("detail-srv"));

    // Expanded details should show type, command, and scope
    expect(screen.getByText("stdio")).toBeInTheDocument();
    expect(screen.getByText(/npx/)).toBeInTheDocument();
    expect(screen.getByText("project")).toBeInTheDocument();
  });

  it("shows tools list when server has tools", () => {
    // Expanded view should list available tools
    const servers = [
      makeServer({
        name: "tool-srv",
        tools: [
          { name: "read_file" },
          { name: "write_file", annotations: { destructive: true } },
        ],
      }),
    ];
    mockState.mcpServers = new Map([["s1", servers]]);
    render(<McpSection sessionId="s1" />);

    // Expand the server
    fireEvent.click(screen.getByText("tool-srv"));

    expect(screen.getByText("Tools (2)")).toBeInTheDocument();
    expect(screen.getByText("read_file")).toBeInTheDocument();
    expect(screen.getByText("write_file")).toBeInTheDocument();
  });

  it("shows error message when server has an error", () => {
    // Failed servers with an error message should display it in the expanded view
    const servers = [
      makeServer({
        name: "err-srv",
        status: "failed",
        error: "Connection refused on port 3000",
      }),
    ];
    mockState.mcpServers = new Map([["s1", servers]]);
    render(<McpSection sessionId="s1" />);

    // Expand the server
    fireEvent.click(screen.getByText("err-srv"));

    expect(screen.getByText("Connection refused on port 3000")).toBeInTheDocument();
  });

  it("shows URL in expanded view for sse/http servers", () => {
    // SSE and HTTP servers should display their URL instead of command
    const servers = [
      makeServer({
        name: "sse-srv",
        config: { type: "sse", url: "http://example.com/mcp" },
      }),
    ];
    mockState.mcpServers = new Map([["s1", servers]]);
    render(<McpSection sessionId="s1" />);

    fireEvent.click(screen.getByText("sse-srv"));

    expect(screen.getByText("http://example.com/mcp")).toBeInTheDocument();
  });
});

describe("McpSection accessibility", () => {
  it("passes axe accessibility checks with no servers", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<McpSection sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks with servers", async () => {
    const { axe } = await import("vitest-axe");
    const servers = [
      makeServer({ name: "a-srv", status: "connected" }),
      makeServer({ name: "b-srv", status: "failed" }),
    ];
    mockState.mcpServers = new Map([["s1", servers]]);
    const { container } = render(<McpSection sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks with add form open", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ─── Feature suite: scope-gating and file-scope delete/edit (session "test-session") ──

describe("McpPanel remove button", () => {
  it("renders remove button for each server", () => {
    // All non-claudeai servers should have remove buttons
    mockState.mcpServers = new Map([["test-session", [
      makeServer({ name: "server-a" }),
      makeServer({ name: "server-b" }),
    ]]]);
    render(<McpSection sessionId="test-session" />);
    const removeButtons = screen.getAllByTitle("Remove server");
    expect(removeButtons).toHaveLength(2);
  });

  it("does NOT render edit/remove buttons for claudeai-scoped servers", () => {
    // claudeai servers are managed by claude.ai, not the SDK — can't be edited/removed
    mockState.mcpServers = new Map([["test-session", [
      makeServer({ name: "claude.ai Calendar", scope: "claudeai" }),
    ]]]);
    render(<McpSection sessionId="test-session" />);
    expect(screen.queryByTitle("Remove server")).toBeNull();
    expect(screen.queryByTitle("Edit server")).toBeNull();
  });

  it("renders edit/remove buttons for project-scoped servers", () => {
    mockState.mcpServers = new Map([["test-session", [
      makeServer({ name: "local-mcp", scope: "project" }),
    ]]]);
    render(<McpSection sessionId="test-session" />);
    expect(screen.getByTitle("Remove server")).toBeTruthy();
    expect(screen.getByTitle("Edit server")).toBeTruthy();
  });

  it("renders edit/remove buttons for user-scoped servers", () => {
    mockState.mcpServers = new Map([["test-session", [
      makeServer({ name: "user-mcp", scope: "user" }),
    ]]]);
    render(<McpSection sessionId="test-session" />);
    expect(screen.getByTitle("Remove server")).toBeTruthy();
    expect(screen.getByTitle("Edit server")).toBeTruthy();
  });

  it("renders edit/remove buttons for local-scoped servers", () => {
    mockState.mcpServers = new Map([["test-session", [
      makeServer({ name: "local-mcp", scope: "local" }),
    ]]]);
    render(<McpSection sessionId="test-session" />);
    expect(screen.getByTitle("Remove server")).toBeTruthy();
    expect(screen.getByTitle("Edit server")).toBeTruthy();
  });

  it("renders edit/remove buttons for managed-scoped servers", () => {
    mockState.mcpServers = new Map([["test-session", [
      makeServer({ name: "dynamic-server", scope: "managed" }),
    ]]]);
    render(<McpSection sessionId="test-session" />);
    expect(screen.getByTitle("Remove server")).toBeTruthy();
    expect(screen.getByTitle("Edit server")).toBeTruthy();
  });

  it("renders edit/remove buttons for servers with empty scope", () => {
    mockState.mcpServers = new Map([["test-session", [
      makeServer({ name: "unknown-scope", scope: "" }),
    ]]]);
    render(<McpSection sessionId="test-session" />);
    expect(screen.getByTitle("Remove server")).toBeTruthy();
    expect(screen.getByTitle("Edit server")).toBeTruthy();
  });

  it("remove sends mcp_set_servers with only remaining managed servers", () => {
    // Mix of managed and non-managed servers — removing a managed one should
    // only filter managed servers in the payload; file-based are excluded.
    mockState.mcpServers = new Map([["test-session", [
      makeServer({ name: "keep-me", scope: "managed", config: { type: "stdio", command: "keep" } }),
      makeServer({ name: "remove-me", scope: "managed", config: { type: "sse", url: "http://remove" } }),
      makeServer({ name: "file-based", scope: "project", config: { type: "stdio", command: "proj" } }),
      makeServer({ name: "cloud-based", scope: "claudeai", config: { type: "claudeai-proxy" as "stdio", url: "http://cloud" } }),
    ]]]);
    render(<McpSection sessionId="test-session" />);

    // managed + project servers should have remove buttons (not claudeai)
    const removeButtons = screen.getAllByTitle("Remove server");
    expect(removeButtons).toHaveLength(3);

    // Click remove on the second managed server ("remove-me")
    fireEvent.click(removeButtons[1]);

    // Should call sendMcpSetServers with ONLY the remaining managed server
    expect(mockSendMcpSetServers).toHaveBeenCalledTimes(1);
    expect(mockSendMcpSetServers).toHaveBeenCalledWith("test-session", {
      "keep-me": { type: "stdio", command: "keep" },
    });
  });

  it("remove of project-scoped server sends mcp_delete_file_server", () => {
    mockState.mcpServers = new Map([["test-session", [
      makeServer({ name: "proj-server", scope: "project", config: { type: "stdio", command: "proj" } }),
    ]]]);
    render(<McpSection sessionId="test-session" />);
    fireEvent.click(screen.getByTitle("Remove server"));
    expect(mockSendMcpDeleteFileServer).toHaveBeenCalledWith("test-session", "proj-server", "project");
    expect(mockSendMcpSetServers).not.toHaveBeenCalled();
  });

  it("remove of user-scoped server sends mcp_delete_file_server", () => {
    mockState.mcpServers = new Map([["test-session", [
      makeServer({ name: "user-server", scope: "user", config: { type: "stdio", command: "u" } }),
    ]]]);
    render(<McpSection sessionId="test-session" />);
    fireEvent.click(screen.getByTitle("Remove server"));
    expect(mockSendMcpDeleteFileServer).toHaveBeenCalledWith("test-session", "user-server", "user");
  });

  it("remove of local-scoped server sends mcp_delete_file_server", () => {
    mockState.mcpServers = new Map([["test-session", [
      makeServer({ name: "local-server", scope: "local", config: { type: "stdio", command: "l" } }),
    ]]]);
    render(<McpSection sessionId="test-session" />);
    fireEvent.click(screen.getByTitle("Remove server"));
    expect(mockSendMcpDeleteFileServer).toHaveBeenCalledWith("test-session", "local-server", "local");
  });

  it("remove of only managed server sends empty map", () => {
    mockState.mcpServers = new Map([["test-session", [
      makeServer({ name: "only-dynamic", scope: "managed" }),
      makeServer({ name: "claudeai-server", scope: "claudeai" }),
    ]]]);
    render(<McpSection sessionId="test-session" />);

    const removeButton = screen.getByTitle("Remove server");
    fireEvent.click(removeButton);

    // Should send empty map — clears all dynamic servers, claudeai unaffected
    expect(mockSendMcpSetServers).toHaveBeenCalledWith("test-session", {});
  });
});

// ─── Edit button ─────────────────────────────────────────────────────────────

describe("McpPanel edit button", () => {
  it("clicking edit shows ServerForm with pre-filled values", () => {
    mockState.mcpServers = new Map([["test-session", [
      makeServer({
        name: "my-server",
        scope: "managed",
        config: { type: "stdio", command: "npx", args: ["-y", "server"] },
      }),
    ]]]);
    render(<McpSection sessionId="test-session" />);

    fireEvent.click(screen.getByTitle("Edit server"));

    // Should show a form with the server name pre-filled and read-only
    const nameInput = screen.getByDisplayValue("my-server") as HTMLInputElement;
    expect(nameInput.readOnly).toBe(true);

    // Should show Save button instead of Add Server
    expect(screen.getByText("Save")).toBeTruthy();
    expect(screen.queryByText("Add Server")).toBeNull();
  });

  it("edit submit sends mcp_set_servers with only managed servers", () => {
    mockState.mcpServers = new Map([["test-session", [
      makeServer({
        name: "edit-me",
        scope: "managed",
        config: { type: "sse", url: "http://old-url" },
      }),
      makeServer({ name: "file-server", scope: "project", config: { type: "stdio", command: "x" } }),
    ]]]);
    render(<McpSection sessionId="test-session" />);

    // Click edit on first server (managed)
    const editButtons = screen.getAllByTitle("Edit server");
    fireEvent.click(editButtons[0]);

    // Change the URL
    const urlInput = screen.getByDisplayValue("http://old-url");
    fireEvent.change(urlInput, { target: { value: "http://new-url" } });

    // Submit
    fireEvent.click(screen.getByText("Save"));

    // Should only include managed servers, with updated config
    expect(mockSendMcpSetServers).toHaveBeenCalledWith("test-session", {
      "edit-me": { type: "sse", url: "http://new-url" },
    });
  });

  it("edit submit sends mcp_edit_file_server for project-scoped server", () => {
    mockState.mcpServers = new Map([["test-session", [
      makeServer({
        name: "proj-server",
        scope: "project",
        config: { type: "sse", url: "http://old-url" },
      }),
    ]]]);
    render(<McpSection sessionId="test-session" />);

    fireEvent.click(screen.getByTitle("Edit server"));

    const urlInput = screen.getByDisplayValue("http://old-url");
    fireEvent.change(urlInput, { target: { value: "http://new-url" } });

    fireEvent.click(screen.getByText("Save"));

    expect(mockSendMcpEditFileServer).toHaveBeenCalledWith(
      "test-session",
      "proj-server",
      "project",
      { type: "sse", url: "http://new-url" },
    );
    expect(mockSendMcpSetServers).not.toHaveBeenCalled();
  });
});

// ─── Add form ─────────────────────────────────────────────────────────────────

describe("McpPanel add form", () => {
  it("add sends only the new server config (not all servers)", () => {
    mockState.mcpServers = new Map([["test-session", [
      makeServer({ name: "existing", scope: "managed" }),
    ]]]);
    render(<McpSection sessionId="test-session" />);

    // Click the add button
    fireEvent.click(screen.getByTitle("Add MCP server"));

    // Fill in form
    fireEvent.change(screen.getByPlaceholderText("my-mcp-server"), {
      target: { value: "new-server" },
    });
    fireEvent.change(screen.getByPlaceholderText("npx -y @modelcontextprotocol/server-memory"), {
      target: { value: "node new.js" },
    });

    // Submit
    fireEvent.click(screen.getByText("Add Server"));

    // Should send only the new server — CLI merges with existing dynamic set
    expect(mockSendMcpSetServers).toHaveBeenCalledWith("test-session", {
      "new-server": { type: "stdio", command: "node new.js" },
    });
  });
});
