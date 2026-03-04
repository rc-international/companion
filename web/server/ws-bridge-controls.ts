import { randomUUID } from "node:crypto";
import type {
  CLIControlResponseMessage,
  BrowserIncomingMessage,
  McpServerDetail,
} from "./session-types.js";
import type { Session } from "./ws-bridge-types.js";
import {
  isFileScope,
  settingsPathForScope,
  removeServerFromSettings,
  updateServerInSettings,
} from "./claude-settings.js";

export function handleInterrupt(
  session: Session,
  sendToCLI: (session: Session, ndjson: string) => void,
): void {
  const ndjson = JSON.stringify({
    type: "control_request",
    request_id: randomUUID(),
    request: { subtype: "interrupt" },
  });
  sendToCLI(session, ndjson);
}

export function handleSetModel(
  session: Session,
  model: string,
  sendToCLI: (session: Session, ndjson: string) => void,
): void {
  const ndjson = JSON.stringify({
    type: "control_request",
    request_id: randomUUID(),
    request: { subtype: "set_model", model },
  });
  sendToCLI(session, ndjson);
}

export function handleSetPermissionMode(
  session: Session,
  mode: string,
  sendToCLI: (session: Session, ndjson: string) => void,
): void {
  const ndjson = JSON.stringify({
    type: "control_request",
    request_id: randomUUID(),
    request: { subtype: "set_permission_mode", mode },
  });
  sendToCLI(session, ndjson);
}

export function handleSetAiValidation(
  session: Session,
  msg: {
    aiValidationEnabled?: boolean | null;
    aiValidationAutoApprove?: boolean | null;
    aiValidationAutoDeny?: boolean | null;
  },
): void {
  if (msg.aiValidationEnabled !== undefined) {
    session.state.aiValidationEnabled = msg.aiValidationEnabled;
  }
  if (msg.aiValidationAutoApprove !== undefined) {
    session.state.aiValidationAutoApprove = msg.aiValidationAutoApprove;
  }
  if (msg.aiValidationAutoDeny !== undefined) {
    session.state.aiValidationAutoDeny = msg.aiValidationAutoDeny;
  }
}

export function handleControlResponse(
  session: Session,
  msg: CLIControlResponseMessage,
  loggerWarn: (message: string) => void,
): void {
  const reqId = msg.response.request_id;
  const pending = session.pendingControlRequests.get(reqId);
  if (!pending) return;
  session.pendingControlRequests.delete(reqId);
  if (msg.response.subtype === "error") {
    loggerWarn(`[ws-bridge] Control request ${pending.subtype} failed: ${msg.response.error}`);
    return;
  }
  pending.resolve(msg.response.response ?? {});
}

export function sendControlRequest(
  session: Session,
  request: Record<string, unknown>,
  sendToCLI: (session: Session, ndjson: string) => void,
  onResponse?: { subtype: string; resolve: (response: unknown) => void },
): void {
  const requestId = randomUUID();
  if (onResponse) {
    session.pendingControlRequests.set(requestId, onResponse);
  }
  const ndjson = JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request,
  });
  sendToCLI(session, ndjson);
}

export function handleMcpGetStatus(
  session: Session,
  sendControlRequestFn: (
    request: Record<string, unknown>,
    onResponse?: { subtype: string; resolve: (response: unknown) => void },
  ) => void,
  broadcastToBrowsers: (session: Session, msg: BrowserIncomingMessage) => void,
): void {
  sendControlRequestFn({ subtype: "mcp_status" }, {
    subtype: "mcp_status",
    resolve: (response) => {
      const servers = (response as { mcpServers?: McpServerDetail[] }).mcpServers ?? [];
      broadcastToBrowsers(session, { type: "mcp_status", servers });
    },
  });
}

export function handleMcpToggle(
  sendControlRequestFn: (request: Record<string, unknown>) => void,
  serverName: string,
  enabled: boolean,
  refreshStatus: () => void,
): void {
  sendControlRequestFn({ subtype: "mcp_toggle", serverName, enabled });
  setTimeout(refreshStatus, 500);
}

export function handleMcpReconnect(
  sendControlRequestFn: (request: Record<string, unknown>) => void,
  serverName: string,
  refreshStatus: () => void,
): void {
  sendControlRequestFn({ subtype: "mcp_reconnect", serverName });
  setTimeout(refreshStatus, 1000);
}

export function handleMcpSetServers(
  sendControlRequestFn: (request: Record<string, unknown>) => void,
  servers: Record<string, unknown>,
  refreshStatus: () => void,
): void {
  sendControlRequestFn({ subtype: "mcp_set_servers", servers });
  setTimeout(refreshStatus, 2000);
}

export function handleMcpDeleteFileServer(
  session: Session,
  serverName: string,
  scope: string,
  sendControlRequestFn: (request: Record<string, unknown>) => void,
  refreshStatus: () => void,
): void {
  if (!isFileScope(scope)) {
    console.warn(`[${session.id.slice(-8)}] mcp_delete_file_server: invalid scope "${scope}"`);
    return;
  }
  const repoRoot = session.state.repo_root || session.state.cwd;
  const filePath = settingsPathForScope(scope, repoRoot);
  console.log(`[${session.id.slice(-8)}] Deleting MCP server "${serverName}" from ${scope} settings: ${filePath}`);

  const removed = removeServerFromSettings(filePath, serverName);
  if (!removed) {
    console.warn(`[${session.id.slice(-8)}] Server "${serverName}" not found in ${filePath}`);
  }
  // Disable in the running session immediately
  sendControlRequestFn({ subtype: "mcp_toggle", serverName, enabled: false });
  setTimeout(refreshStatus, 500);
}

export function handleMcpEditFileServer(
  session: Session,
  serverName: string,
  scope: string,
  config: Record<string, unknown>,
  sendControlRequestFn: (request: Record<string, unknown>) => void,
  refreshStatus: () => void,
): void {
  if (!isFileScope(scope)) {
    console.warn(`[${session.id.slice(-8)}] mcp_edit_file_server: invalid scope "${scope}"`);
    return;
  }
  const repoRoot = session.state.repo_root || session.state.cwd;
  const filePath = settingsPathForScope(scope, repoRoot);
  console.log(`[${session.id.slice(-8)}] Editing MCP server "${serverName}" in ${scope} settings: ${filePath}`);

  updateServerInSettings(filePath, serverName, config);
  // Reconnect so the CLI picks up the new config
  sendControlRequestFn({ subtype: "mcp_reconnect", serverName });
  setTimeout(refreshStatus, 1000);
}
