import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { registerHookRoutes } from "./routes/hook-routes.js";

/** Create a minimal test app with hook routes registered */
function createTestApp() {
  const app = new Hono();
  registerHookRoutes(app);
  return app;
}

describe("hook-routes", () => {
  it("POST /hooks/session-start returns 200", async () => {
    const app = createTestApp();
    const res = await app.request("/hooks/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "test-123",
        transcript_path: "/tmp/test.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "SessionStart",
        source: "startup",
        model: "claude-opus-4-6",
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toBeDefined();
  });

  it("POST /hooks/session-end returns 200", async () => {
    const app = createTestApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "test-123",
        transcript_path: "/tmp/test.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "SessionEnd",
        reason: "other",
      }),
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
