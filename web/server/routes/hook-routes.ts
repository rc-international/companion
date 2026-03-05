import type { Hono } from "hono";
import type {
  SessionStartInput,
  SessionStartResponse,
  SessionEndInput,
  HookResponse,
} from "../hook-types.js";
import { registerSession, getActiveSessions } from "../session-db.js";

export interface HookRouteDeps {
  // biome-ignore lint: hook events use a loose shape to avoid coupling to BrowserIncomingMessage union
  wsBridge?: { broadcastToSession: (sessionId: string, msg: any) => void };
}

export function registerHookRoutes(app: Hono, deps?: HookRouteDeps): void {
  const broadcast = (
    event: string,
    sessionId: string,
    data?: Record<string, unknown>,
  ) => {
    deps?.wsBridge?.broadcastToSession(sessionId, {
      type: "hook_event",
      event,
      session_id: sessionId,
      timestamp: Date.now(),
      ...data,
    });
  };

  app.post("/hooks/session-start", async (c) => {
    const input = await c.req.json<SessionStartInput>();
    const projectName = input.cwd.split("/").pop() || "unknown";
    console.log(
      `[hooks] SessionStart session=${input.session_id.slice(-8)} source=${input.source} project=${projectName}`,
    );

    // Register session in DB (fire-and-forget)
    registerSession(input.session_id, input.cwd, "").catch(() => {});

    // Get peer sessions for context injection
    const peers = await getActiveSessions(input.cwd);
    const otherPeers = peers.filter((s) => s.id !== input.session_id);

    let context = `Session: ${input.session_id.slice(-8)} | Project: ${projectName}\n`;
    if (otherPeers.length > 0) {
      context += `Active peers (${otherPeers.length}):\n`;
      for (const p of otherPeers) {
        context += `  - ${p.id}: ${p.working_on || "working..."}\n`;
      }
    } else {
      context += "No other sessions active on this project.\n";
    }

    broadcast("SessionStart", input.session_id, { source: input.source });

    const response: SessionStartResponse = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    };
    return c.json(response);
  });

  app.post("/hooks/session-end", async (c) => {
    const input = await c.req.json<SessionEndInput>();
    console.log(
      `[hooks] SessionEnd session=${input.session_id.slice(-8)} reason=${input.reason}`,
    );

    broadcast("SessionEnd", input.session_id, { reason: input.reason });

    return c.json({} satisfies HookResponse);
  });

  // Catch-all for unknown hook events — must be registered after specific routes
  app.all("/hooks/:event", (c) => {
    if (c.req.method !== "POST") {
      return c.json({ error: "Method not allowed" }, 405);
    }
    return c.json({ error: "Unknown hook event" }, 404);
  });
}
