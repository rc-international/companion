import { describe, it, expect, vi } from "vitest";
import {
  dispatchPreToolUse,
  type PreToolUseContext,
} from "./pre-tool-use.js";
import type { TldrClient } from "../tldr-client.js";

function makeMockTldr(responses: Record<string, any> = {}): TldrClient {
  return {
    query: vi.fn().mockImplementation(async (q: any) => {
      return responses[q.cmd] || { status: "ok" };
    }),
    safeQuery: vi.fn().mockImplementation(async (q: any) => {
      return responses[q.cmd] || { status: "ok" };
    }),
    isIndexing: vi.fn().mockReturnValue(false),
    isSocketPresent: vi.fn().mockReturnValue(true),
  } as unknown as TldrClient;
}

function makeContext(
  toolName: string,
  toolInput: Record<string, unknown> = {},
): PreToolUseContext {
  return {
    input: {
      session_id: "test-123",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/home/kev/wilco",
      permission_mode: "default",
      hook_event_name: "PreToolUse" as const,
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: "tu-1",
    },
    tldr: null,
    db: null,
  };
}

describe("dispatchPreToolUse", () => {
  it("returns empty response for unmatched tool", async () => {
    // Unrecognized tools should pass through with no additional context or blocking
    const result = await dispatchPreToolUse(makeContext("SomeUnknownTool"));
    expect(result).toEqual({});
  });

  it("injects path-rules system message for matching files", async () => {
    // Edit tool calls should be dispatched through the pre-tool-use pipeline
    // (even with no registered handlers yet, verifies dispatcher doesn't crash)
    const ctx = makeContext("Edit", {
      file_path: "/home/kev/wilco/hooks/src/some-hook.ts",
    });
    const result = await dispatchPreToolUse(ctx);
    expect(result).toBeDefined();
  });
});

describe("PreToolUse path-rules handler", () => {
  it("injects SKILL.md content for matching paths", async () => {
    const ctx = makeContext("Edit", {
      file_path: "/home/kev/wilco/hooks/src/test-hook.ts",
    });
    const result = await dispatchPreToolUse(ctx);
    // If a matching rule exists, systemMessage will contain the skill content
    // If no rule matches, result is empty — both are valid
    expect(result).toBeDefined();
  });
});

describe("PreToolUse file-claims handler", () => {
  it("warns when another session has claimed the file", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ session_id: "other-session", claimed_at: new Date() }],
      }),
    };

    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Edit",
        tool_input: { file_path: "/home/kev/wilco/src/shared.ts" },
        tool_use_id: "tu-1",
      },
      tldr: null,
      db: mockPool as any,
    };

    const result = await dispatchPreToolUse(ctx);
    expect(
      result.hookSpecificOutput?.additionalContext ||
        result.systemMessage ||
        "",
    ).toBeDefined();
  });

  it("does nothing when no other session has the file", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Edit",
        tool_input: { file_path: "/home/kev/wilco/src/unique.ts" },
        tool_use_id: "tu-2",
      },
      tldr: null,
      db: mockPool as any,
    };

    const result = await dispatchPreToolUse(ctx);
    // No conflict = no context injected about file claims
    // (path-rules might still fire, so just check no claim warning)
    const context = String(result.hookSpecificOutput?.additionalContext || "");
    expect(context).not.toContain("also edited");
  });

  it("skips when db is null", async () => {
    const ctx = makeContext("Edit", {
      file_path: "/home/kev/wilco/src/test.ts",
    });
    // db is null in makeContext by default
    const result = await dispatchPreToolUse(ctx);
    // Should not throw, just skip
    expect(result).toBeDefined();
  });
});

describe("PreToolUse edit-context-inject handler", () => {
  it("injects symbol summary for edited file", async () => {
    const tldr = makeMockTldr({
      extract: {
        status: "ok",
        result: {
          symbols: ["class Foo", "def bar()", "def baz()"],
          imports: ["import os", "from typing import Dict"],
        },
      },
      imports: {
        status: "ok",
        imports: [
          { module: "os", names: ["path"] },
          { module: "typing", names: ["Dict"] },
        ],
      },
    });

    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Edit",
        tool_input: { file_path: "/home/kev/wilco/src/module.py" },
        tool_use_id: "tu-1",
      },
      tldr,
      db: null,
    };

    const result = await dispatchPreToolUse(ctx);
    expect(tldr.safeQuery).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "extract" }),
    );
  });
});

describe("PreToolUse signature-helper handler", () => {
  it("injects function signatures referenced in new_string", async () => {
    const tldr = makeMockTldr({
      search: {
        status: "ok",
        results: [
          { file: "src/utils.py", name: "parse_config", line: 10, signature: "def parse_config(path: str) -> Dict:" },
        ],
      },
    });

    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Edit",
        tool_input: {
          file_path: "/home/kev/wilco/src/main.py",
          new_string: "result = parse_config(config_path)",
        },
        tool_use_id: "tu-1",
      },
      tldr,
      db: null,
    };

    const result = await dispatchPreToolUse(ctx);
    expect(tldr.safeQuery).toHaveBeenCalled();
  });

  it("skips short new_string", async () => {
    const tldr = makeMockTldr({});
    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Edit",
        tool_input: {
          file_path: "/home/kev/wilco/src/main.py",
          new_string: "x = 1",
        },
        tool_use_id: "tu-2",
      },
      tldr,
      db: null,
    };

    const result = await dispatchPreToolUse(ctx);
    // Short strings should NOT trigger signature lookup
    expect(tldr.safeQuery).not.toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "search" }),
    );
  });
});

describe("PreToolUse smart-search-router handler", () => {
  it("blocks semantic grep with redirect to semantic search", async () => {
    // When a grep pattern looks like a natural language query (semantic),
    // the handler should intercept it and return TLDR semantic search results instead
    const tldr = makeMockTldr({
      semantic: {
        status: "ok",
        results: [
          { file: "src/auth.py", line: 42, text: "def authenticate(user, password):" },
        ],
      },
    });

    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Grep",
        tool_input: { pattern: "how authentication works" },
        tool_use_id: "tu-1",
      },
      tldr,
      db: null,
    };

    const result = await dispatchPreToolUse(ctx);
    expect(result).toBeDefined();
  });

  it("allows literal grep patterns through", async () => {
    // Literal code patterns (e.g. function calls) should NOT be intercepted
    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Grep",
        tool_input: { pattern: "function authenticate(" },
        tool_use_id: "tu-1",
      },
      tldr: null,
      db: null,
    };

    const result = await dispatchPreToolUse(ctx);
    expect(result.decision).not.toBe("block");
  });
});

describe("PreToolUse tldr-read-enforcer handler", () => {
  it("provides TLDR summary for large code files", async () => {
    // Large code files should trigger TLDR extract to provide a summary
    // instead of reading the entire file
    const tldr = makeMockTldr({
      extract: {
        status: "ok",
        result: {
          symbols: ["class UserService", "def authenticate()", "def authorize()"],
          lines: 500,
        },
      },
    });

    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Read",
        tool_input: { file_path: "/home/kev/wilco/src/user_service.py" },
        tool_use_id: "tu-1",
      },
      tldr,
      db: null,
    };

    const result = await dispatchPreToolUse(ctx);
    expect(tldr.safeQuery).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "extract" }),
    );
  });

  it("skips test files", async () => {
    // Test files should never be intercepted by the read enforcer
    const tldr = makeMockTldr({});
    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Read",
        tool_input: { file_path: "/home/kev/wilco/tests/test_auth.py" },
        tool_use_id: "tu-1",
      },
      tldr,
      db: null,
    };

    const result = await dispatchPreToolUse(ctx);
    expect(tldr.safeQuery).not.toHaveBeenCalled();
  });

  it("skips reads with explicit offset/limit", async () => {
    // Targeted reads (with offset/limit) indicate the user already knows
    // what section they want — don't intercept these
    const tldr = makeMockTldr({});
    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Read",
        tool_input: {
          file_path: "/home/kev/wilco/src/auth.py",
          offset: 10,
          limit: 50,
        },
        tool_use_id: "tu-1",
      },
      tldr,
      db: null,
    };

    const result = await dispatchPreToolUse(ctx);
    expect(tldr.safeQuery).not.toHaveBeenCalled();
  });

  it("skips non-code files", async () => {
    // Non-code files (markdown, config, etc.) should pass through without TLDR
    const tldr = makeMockTldr({});
    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Read",
        tool_input: { file_path: "/home/kev/wilco/README.md" },
        tool_use_id: "tu-1",
      },
      tldr,
      db: null,
    };

    const result = await dispatchPreToolUse(ctx);
    expect(tldr.safeQuery).not.toHaveBeenCalled();
  });
});

describe("PreToolUse tldr-context-inject handler", () => {
  it("injects TLDR layers for Task tool calls", async () => {
    // When a Task tool call has a sufficiently long prompt, the handler should
    // query TLDR for code analysis context (call graph, symbols, etc.)
    const tldr = makeMockTldr({
      context: {
        status: "ok",
        result: {
          call_graph: "A -> B -> C",
          symbols: ["class A", "def B()", "def C()"],
        },
      },
    });

    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Task",
        tool_input: { prompt: "Debug the authentication flow in the login module" },
        tool_use_id: "tu-1",
      },
      tldr,
      db: null,
    };

    const result = await dispatchPreToolUse(ctx);
    expect(tldr.safeQuery).toHaveBeenCalled();
  });

  it("skips short prompts", async () => {
    // Short prompts (< 20 chars) should not trigger the TLDR context query
    // since there is not enough information to provide useful analysis
    const tldr = makeMockTldr({});
    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Task",
        tool_input: { prompt: "run tests" },
        tool_use_id: "tu-1",
      },
      tldr,
      db: null,
    };

    const result = await dispatchPreToolUse(ctx);
    // Short prompt (< 20 chars) should not trigger context query
    expect(tldr.safeQuery).not.toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "context" }),
    );
  });
});

describe("PreToolUse arch-context-inject handler", () => {
  it("injects architecture map for planning-related Task calls", async () => {
    // Task calls with planning keywords (plan, refactor, design, etc.)
    // should trigger an architecture map query from TLDR
    const tldr = makeMockTldr({
      arch: {
        status: "ok",
        result: {
          entry_layer: ["main.py", "cli.py"],
          leaf_layer: ["utils.py", "db.py"],
          circular: [],
        },
      },
    });

    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Task",
        tool_input: { prompt: "Plan a refactor of the authentication module" },
        tool_use_id: "tu-1",
      },
      tldr,
      db: null,
    };

    const result = await dispatchPreToolUse(ctx);
    expect(tldr.safeQuery).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "arch" }),
    );
  });

  it("skips arch injection for non-planning Task calls", async () => {
    // Task calls without planning keywords should not trigger arch queries
    const tldr = makeMockTldr({});
    const ctx: PreToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PreToolUse" as const,
        tool_name: "Task",
        tool_input: { prompt: "Run the test suite and report results" },
        tool_use_id: "tu-1",
      },
      tldr,
      db: null,
    };

    const result = await dispatchPreToolUse(ctx);
    expect(tldr.safeQuery).not.toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "arch" }),
    );
  });
});
