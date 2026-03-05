import { describe, it, expect } from "vitest";
import { handleSessionEnd } from "./session-end.js";
import type { SessionEndInput } from "../hook-types.js";

describe("handleSessionEnd", () => {
  const baseInput: SessionEndInput = {
    session_id: "test-abc-123",
    transcript_path: "/tmp/test.jsonl",
    cwd: "/tmp/nonexistent-project", // use nonexistent path so cache cleanup is a no-op
    permission_mode: "default",
    hook_event_name: "SessionEnd",
    reason: "other",
  };

  it("returns a valid response for normal session end", async () => {
    const result = await handleSessionEnd(baseInput);
    expect(result).toBeDefined();
    // Should return empty response (no blocking, no special output)
    expect(result.decision).toBeUndefined();
  });

  it("succeeds for clear/logout reasons (skips learnings)", async () => {
    const result = await handleSessionEnd({ ...baseInput, reason: "clear" });
    expect(result).toBeDefined();
  });

  it("succeeds for prompt_input_exit reason", async () => {
    const result = await handleSessionEnd({
      ...baseInput,
      reason: "prompt_input_exit",
    });
    expect(result).toBeDefined();
  });
});
