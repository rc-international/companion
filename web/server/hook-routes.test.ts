import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerHookRoutes } from "./routes/hook-routes.js";

// Mock session-db so tests don't need real PostgreSQL
vi.mock("./session-db.js", () => ({
  registerSession: vi.fn().mockResolvedValue(undefined),
  getActiveSessions: vi.fn().mockResolvedValue([]),
}));

/** Create a minimal test app with hook routes registered */
function createTestApp(deps?: Parameters<typeof registerHookRoutes>[1]) {
  const app = new Hono();
  registerHookRoutes(app, deps);
  return app;
}

const SESSION_START_BODY = {
  session_id: "test-123",
  transcript_path: "/tmp/test.jsonl",
  cwd: "/home/kev/wilco",
  permission_mode: "default",
  hook_event_name: "SessionStart",
  source: "startup",
  model: "claude-opus-4-6",
};

const SESSION_END_BODY = {
  session_id: "test-123",
  transcript_path: "/tmp/test.jsonl",
  cwd: "/home/kev/wilco",
  permission_mode: "default",
  hook_event_name: "SessionEnd",
  reason: "other",
};

describe("hook-routes", () => {
  it("POST /hooks/session-start returns 200 with additionalContext", async () => {
    const app = createTestApp();
    const res = await app.request("/hooks/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SESSION_START_BODY),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    // Should include hookSpecificOutput with session context
    expect(json.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(json.hookSpecificOutput?.additionalContext).toContain("test-123");
  });

  it("POST /hooks/session-end returns 200", async () => {
    const app = createTestApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SESSION_END_BODY),
    });
    expect(res.status).toBe(200);
  });

  it("POST /hooks/unknown returns 404", async () => {
    const app = createTestApp();
    const res = await app.request("/hooks/nonexistent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("rejects non-POST methods with 405", async () => {
    const app = createTestApp();
    const res = await app.request("/hooks/session-start", { method: "GET" });
    expect(res.status).toBe(405);
  });
});

describe("POST /hooks/session-start handler", () => {
  it("returns additionalContext with peer session awareness", async () => {
    // Mock peers present
    const { getActiveSessions } = await import("./session-db.js");
    (getActiveSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "peer-abc-1", working_on: "refactoring auth" },
    ]);

    const app = createTestApp();
    const res = await app.request("/hooks/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SESSION_START_BODY),
    });

    const json = await res.json();
    // Should mention peer session in context
    expect(json.hookSpecificOutput?.additionalContext).toContain("peer-abc-1");
    expect(json.hookSpecificOutput?.additionalContext).toContain(
      "refactoring auth",
    );
  });

  it("returns context without peers when none active", async () => {
    const { getActiveSessions } = await import("./session-db.js");
    (getActiveSessions as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const app = createTestApp();
    const res = await app.request("/hooks/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SESSION_START_BODY),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.hookSpecificOutput?.additionalContext).toContain(
      "No other sessions",
    );
  });
});
