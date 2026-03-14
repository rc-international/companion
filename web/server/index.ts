process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";

// Enrich process PATH at startup so binary resolution and `which` calls can find
// binaries installed via version managers (nvm, volta, fnm, etc.).
// Critical when running as a launchd/systemd service with a restricted PATH.
import { getEnrichedPath } from "./path-resolver.js";
process.env.PATH = getEnrichedPath();

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { cacheControlMiddleware } from "./cache-headers.js";
import { createRoutes } from "./routes.js";
import { CliLauncher } from "./cli-launcher.js";
import { WsBridge } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { WorktreeTracker } from "./worktree-tracker.js";
import { containerManager } from "./container-manager.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { TerminalManager } from "./terminal-manager.js";
import { generateSessionTitle } from "./auto-namer.js";
import * as sessionNames from "./session-names.js";
import { getSettings } from "./settings-manager.js";
import { PRPoller } from "./pr-poller.js";
import { RecorderManager } from "./recorder.js";
import { CronScheduler } from "./cron-scheduler.js";
import { AgentExecutor } from "./agent-executor.js";
import { migrateCronJobsToAgents } from "./agent-cron-migrator.js";
import { CompanionRedisPublisher } from "./redis-publisher.js";

import { SessionLifecycleManager } from "./session-lifecycle.js";
import { startPeriodicCheck } from "./update-checker.js";
import { imagePullManager } from "./image-pull-manager.js";
import { isRunningAsService } from "./service.js";
import { getToken, verifyToken } from "./auth-manager.js";
import { registerHookRoutes } from "./routes/hook-routes.js";
import { getCookie } from "hono/cookie";
import type { SocketData } from "./ws-bridge.js";
import type { ServerWebSocket } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.__COMPANION_PACKAGE_ROOT || resolve(__dirname, "..");

import { DEFAULT_PORT_DEV, DEFAULT_PORT_PROD } from "./constants.js";

const defaultPort = process.env.NODE_ENV === "production" ? DEFAULT_PORT_PROD : DEFAULT_PORT_DEV;
const port = Number(process.env.PORT) || defaultPort;
const idleTimeoutSeconds = Number(process.env.COMPANION_IDLE_TIMEOUT_SECONDS || "0");
const sessionStore = new SessionStore(process.env.COMPANION_SESSION_DIR);
const wsBridge = new WsBridge();
const launcher = new CliLauncher(port);
const worktreeTracker = new WorktreeTracker();
const CONTAINER_STATE_PATH = join(homedir(), ".companion", "containers.json");
const terminalManager = new TerminalManager();
const prPoller = new PRPoller(wsBridge);
const recorder = new RecorderManager();
const cronScheduler = new CronScheduler(launcher, wsBridge);
const agentExecutor = new AgentExecutor(launcher, wsBridge);

// ── Redis publisher for tutor engine events ─────────────────────────────────
const redisPublisher = new CompanionRedisPublisher();
redisPublisher.connect().catch((err) => {
  console.warn("[server] Redis publisher failed to connect:", err.message);
});
wsBridge.setRedisPublisher(redisPublisher);

// ── Restore persisted sessions from disk ────────────────────────────────────
wsBridge.setStore(sessionStore);
wsBridge.setRecorder(recorder);
launcher.setStore(sessionStore);
launcher.setRecorder(recorder);
launcher.restoreFromDisk();
wsBridge.restoreFromDisk();
containerManager.restoreState(CONTAINER_STATE_PATH);

// When the CLI reports its internal session_id, store it for --resume on relaunch
wsBridge.onCLISessionIdReceived((sessionId, cliSessionId) => {
  launcher.setCLISessionId(sessionId, cliSessionId);
});

// When a Codex adapter is created, attach it to the WsBridge
launcher.onCodexAdapterCreated((sessionId, adapter) => {
  wsBridge.attachCodexAdapter(sessionId, adapter);
});

// Start watching PRs when git info is resolved for a session
wsBridge.onSessionGitInfoReadyCallback((sessionId, cwd, branch) => {
  prPoller.watch(sessionId, cwd, branch);
});

// Auto-relaunch CLI when a browser connects to a session with no CLI
// Cooldown: only one relaunch per session per RELAUNCH_COOLDOWN_MS window.
// Claimed immediately (before any async gap) to prevent concurrent browser tabs
// from all passing the guard before any reaches the async relaunch call.
const RELAUNCH_COOLDOWN_MS = 10_000;
const relaunchTimestamps = new Map<string, number>();
function isRelaunchSuppressed(sessionId: string): boolean {
  const lastRelaunch = relaunchTimestamps.get(sessionId) ?? 0;
  const now = Date.now();
  if (now - lastRelaunch < RELAUNCH_COOLDOWN_MS) {
    console.log(
      `[server] Suppressing duplicate relaunch for session ${sessionId} ` +
      `(cooldown: ${Math.round((RELAUNCH_COOLDOWN_MS - (now - lastRelaunch)) / 1000)}s remaining)`
    );
    return true;
  }
  relaunchTimestamps.set(sessionId, now);
  return false;
}
wsBridge.onCLIRelaunchNeededCallback(async (sessionId) => {
  if (isRelaunchSuppressed(sessionId)) return;
  const info = launcher.getSession(sessionId);
  if (info?.archived) return;
  if (!info) {
    // Orphaned session: WsBridge restored it from disk but launcher has no record.
    // This happens after server restarts when launcher.json was lost or migrated.
    // Reconstruct a launcher entry from WsBridge state and attempt relaunch.
    const bridgeSession = wsBridge.getSession(sessionId);
    const state = bridgeSession?.state;
    if (!state?.cwd) {
      console.log(`[server] Session ${sessionId} orphaned with no cwd, cannot recover`);
      relaunchTimestamps.set(sessionId, Date.now());
      wsBridge.broadcastToSession(sessionId, {
        type: "error",
        message: "This session's backend process is gone and cannot be relaunched (no working directory). Please create a new session.",
      });
      return;
    }

    console.log(`[server] Recovering orphaned session ${sessionId} from WsBridge state (cwd=${state.cwd})`);
    const recovered: import("./cli-launcher.js").SdkSessionInfo = {
      sessionId,
      state: "exited",
      cwd: state.cwd,
      createdAt: Date.now(),
      model: state.model || undefined,
      permissionMode: state.permissionMode || undefined,
      backendType: state.backend_type || "claude",
      cliSessionId: state.session_id !== sessionId ? state.session_id : undefined,
    };
    launcher.registerOrphan(recovered);
    // Fall through to the relaunch logic below
  }
  const current = launcher.getSession(sessionId);
  if (current && current.state !== "starting") {
    relaunchTimestamps.set(sessionId, Date.now());
    console.log(`[server] Auto-relaunching CLI for session ${sessionId}`);
    try {
      const result = await launcher.relaunch(sessionId);
      if (!result.ok && result.error) {
        wsBridge.broadcastToSession(sessionId, { type: "error", message: result.error });
      }
    } finally {
      // Cooldown naturally expires after RELAUNCH_COOLDOWN_MS; no cleanup needed
    }
  }
});

// Auto-generate session title after first turn completes
wsBridge.onFirstTurnCompletedCallback(async (sessionId, firstUserMessage) => {
  // Don't overwrite a name that was already set (manual rename or prior auto-name)
  if (sessionNames.getName(sessionId)) return;
  if (!getSettings().anthropicApiKey.trim()) return;
  const info = launcher.getSession(sessionId);
  const model = info?.model || "claude-sonnet-4-6";
  console.log(`[server] Auto-naming session ${sessionId} via Anthropic with model ${model}...`);
  const title = await generateSessionTitle(firstUserMessage, model);
  // Re-check: a manual rename may have occurred while we were generating
  if (title && !sessionNames.getName(sessionId)) {
    console.log(`[server] Auto-named session ${sessionId}: "${title}"`);
    sessionNames.setName(sessionId, title);
    wsBridge.broadcastNameUpdate(sessionId, title);
  }
});

console.log(`[server] Session persistence: ${sessionStore.directory}`);
if (recorder.isGloballyEnabled()) {
  console.log(`[server] Recording enabled (dir: ${recorder.getRecordingsDir()}, max: ${recorder.getMaxLines()} lines)`);
}

const app = new Hono();

app.use("/api/*", cors());
app.route("/api", createRoutes(launcher, wsBridge, sessionStore, worktreeTracker, terminalManager, prPoller, recorder, cronScheduler, agentExecutor));

// Hook gateway — Claude Code hooks POST directly to /hooks/* (not under /api)
registerHookRoutes(app, { wsBridge });

// Dynamic manifest — embeds auth token in start_url so PWA auto-authenticates
// on first launch. iOS gives standalone PWAs isolated storage from Safari,
// so this is the only way to bridge auth across the install boundary.
app.get("/manifest.json", (c) => {
  const manifest = {
    name: "The Companion",
    short_name: "Companion",
    description: "Web UI for Claude Code and Codex",
    start_url: "/",
    scope: "/",
    display: "standalone" as const,
    background_color: "#262624",
    theme_color: "#d97757",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };

  // If the user has an auth cookie (set during login), embed token in start_url.
  // Safari sends this cookie when fetching the manifest at "Add to Home Screen" time.
  const authCookie = getCookie(c, "companion_auth");
  if (authCookie && verifyToken(authCookie)) {
    manifest.start_url = `/?token=${authCookie}`;
  } else {
    // Localhost bypass — always embed the token for same-machine installs
    const bunServer = c.env as { requestIP?: (req: Request) => { address: string } | null };
    const ip = bunServer?.requestIP?.(c.req.raw);
    const addr = ip?.address ?? "";
    if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") {
      manifest.start_url = `/?token=${getToken()}`;
    }
  }

  c.header("Content-Type", "application/manifest+json");
  return c.json(manifest);
});

// In production, serve built frontend using absolute path (works when installed as npm package)
if (process.env.NODE_ENV === "production") {
  const distDir = resolve(packageRoot, "dist");
  app.use("/*", cacheControlMiddleware());
  app.use("/*", serveStatic({ root: distDir }));
  app.get("/*", serveStatic({ path: resolve(distDir, "index.html") }));
}

const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port,
  idleTimeout: idleTimeoutSeconds,
  async fetch(req, server) {
    const url = new URL(req.url);

    // ── CLI WebSocket — Claude Code CLI connects here via --sdk-url ────
    const cliMatch = url.pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
    if (cliMatch) {
      const sessionId = cliMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "cli" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Helper: check if request is from localhost (same machine)
    const reqIp = server.requestIP(req);
    const reqAddr = reqIp?.address ?? "";
    const isLocalhost = reqAddr === "127.0.0.1" || reqAddr === "::1" || reqAddr === "::ffff:127.0.0.1";

    // ── Browser WebSocket — connects to a specific session ─────────────
    const browserMatch = url.pathname.match(/^\/ws\/browser\/([a-f0-9-]+)$/);
    if (browserMatch) {
      const wsToken = url.searchParams.get("token");
      if (!isLocalhost && !verifyToken(wsToken)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const sessionId = browserMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "browser" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── Terminal WebSocket — embedded terminal PTY connection ─────────
    const termMatch = url.pathname.match(/^\/ws\/terminal\/([a-f0-9-]+)$/);
    if (termMatch) {
      const wsToken = url.searchParams.get("token");
      if (!isLocalhost && !verifyToken(wsToken)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const terminalId = termMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "terminal" as const, terminalId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Hono handles the rest
    return app.fetch(req, server);
  },
  websocket: {
    open(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIOpen(ws, data.sessionId);
        launcher.markConnected(data.sessionId);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserOpen(ws, data.sessionId);
      } else if (data.kind === "terminal") {
        terminalManager.addBrowserSocket(ws);
      }
    },
    message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIMessage(ws, msg);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserMessage(ws, msg);
      } else if (data.kind === "terminal") {
        terminalManager.handleBrowserMessage(ws, msg);
      }
    },
    close(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIClose(ws);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserClose(ws);
      } else if (data.kind === "terminal") {
        terminalManager.removeBrowserSocket(ws);
      }
    },
  },
});

const authToken = getToken();
console.log(`Server running on http://localhost:${server.port}`);
console.log();
console.log(`  Auth token: ${authToken}`);
if (process.env.COMPANION_AUTH_TOKEN) {
  console.log("  (using COMPANION_AUTH_TOKEN env var)");
}
console.log();
console.log(`  CLI WebSocket:     ws://localhost:${server.port}/ws/cli/:sessionId`);
console.log(`  Browser WebSocket: ws://localhost:${server.port}/ws/browser/:sessionId`);

if (process.env.NODE_ENV !== "production") {
  console.log("Dev mode: frontend at http://localhost:5174");
}

// ── Server-side keepalive pings ──────────────────────────────────────────────
wsBridge.startKeepalive();

// ── Cron scheduler ──────────────────────────────────────────────────────────
cronScheduler.startAll();

// ── Agent system ────────────────────────────────────────────────────────────
migrateCronJobsToAgents();
agentExecutor.startAll();

// ── Image pull manager — pre-pull missing Docker images for environments ────
imagePullManager.initFromEnvironments();

// ── Update checker ──────────────────────────────────────────────────────────
startPeriodicCheck();
if (isRunningAsService()) {
  console.log("[server] Running as background service");
}

// ── Session lifecycle manager — auto-archive idle sessions ────────────────────
const lifecycleConfig = SessionLifecycleManager.configFromSettings(getSettings());
const lifecycleManager = new SessionLifecycleManager(launcher, wsBridge, sessionStore, lifecycleConfig);
lifecycleManager.start();

// ── Graceful shutdown — persist container state ──────────────────────────────
function gracefulShutdown() {
  console.log("[server] Persisting container state before shutdown...");
  containerManager.persistState(CONTAINER_STATE_PATH);
  process.exit(0);
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// ── Reconnection watchdog ────────────────────────────────────────────────────
// After a server restart, restored CLI processes may not reconnect their
// WebSocket. Give them a grace period, then kill + relaunch any that are
// still in "starting" state (alive but no WS connection).
const RECONNECT_GRACE_MS = Number(process.env.COMPANION_RECONNECT_GRACE_MS || "30000");
const starting = launcher.getStartingSessions();
if (starting.length > 0) {
  console.log(`[server] Waiting ${RECONNECT_GRACE_MS / 1000}s for ${starting.length} CLI process(es) to reconnect...`);
  setTimeout(async () => {
    const stale = launcher.getStartingSessions();
    const now = Date.now();
    for (const info of stale) {
      if (info.archived) continue;
      // Don't relaunch sessions that are past max age — the lifecycle manager
      // will archive them shortly. Relaunching them with --resume loads stale
      // conversation history that then leaks into the respawned session.
      const maxAgeMs = lifecycleConfig.maxSessionAgeMs;
      if (maxAgeMs > 0 && (now - info.createdAt) >= maxAgeMs) {
        console.log(`[server] Skipping relaunch for session ${info.sessionId.slice(-8)}: past max age, lifecycle will archive`);
        continue;
      }
      console.log(`[server] CLI for session ${info.sessionId} did not reconnect, relaunching...`);
      await launcher.relaunch(info.sessionId);
    }
  }, RECONNECT_GRACE_MS);
}
