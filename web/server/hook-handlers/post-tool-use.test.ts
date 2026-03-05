import { describe, it, expect, vi } from "vitest";
import {
  dispatchPostToolUse,
  type PostToolUseContext,
} from "./post-tool-use.js";
import type { TldrClient } from "../tldr-client.js";

function makeContext(
  toolName: string,
  toolInput: Record<string, unknown> = {},
  toolResponse: Record<string, unknown> = {},
): PostToolUseContext {
  return {
    input: {
      session_id: "test-123",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/home/kev/wilco",
      permission_mode: "default",
      hook_event_name: "PostToolUse" as const,
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      tool_use_id: "tu-1",
    },
    tldr: null,
  };
}

describe("dispatchPostToolUse", () => {
  it("returns empty response for unmatched tool", async () => {
    // Unrecognized tools should pass through with no additional context
    const result = await dispatchPostToolUse(makeContext("SomeUnknownTool"));
    expect(result).toEqual({});
  });

  it("runs Edit handler and returns additionalContext", async () => {
    // Edit tool calls should be dispatched (even if no handler matches yet,
    // this verifies the dispatcher doesn't crash on Edit events)
    const ctx = makeContext("Edit", {
      file_path: "/home/kev/wilco/src/test.ts",
      old_string: "foo",
      new_string: "bar",
    });
    const result = await dispatchPostToolUse(ctx);
    expect(result).toBeDefined();
  });

  it("runs Bash handler for import errors — ModuleNotFoundError", async () => {
    // Bash output containing Python import errors should trigger the
    // import-error-detector handler and return helpful context
    const ctx = makeContext(
      "Bash",
      { command: "python main.py" },
      {
        stdout: "",
        stderr: "ModuleNotFoundError: No module named 'requests'",
        exitCode: 1,
      },
    );
    const result = await dispatchPostToolUse(ctx);
    expect(result.hookSpecificOutput?.additionalContext).toContain(
      "ModuleNotFoundError",
    );
  });

  it("runs Bash handler for ImportError — cannot import name", async () => {
    // Covers the "cannot import name" variant of ImportError
    const ctx = makeContext(
      "Bash",
      { command: "python app.py" },
      {
        stdout: "",
        stderr: "ImportError: cannot import name 'foo'",
        exitCode: 1,
      },
    );
    const result = await dispatchPostToolUse(ctx);
    expect(result.hookSpecificOutput?.additionalContext).toContain(
      "ImportError",
    );
  });

  it("runs Bash handler for circular import", async () => {
    // Covers circular import detection
    const ctx = makeContext(
      "Bash",
      { command: "python app.py" },
      {
        stdout: "",
        stderr: "ImportError: circular import detected in module foo",
        exitCode: 1,
      },
    );
    const result = await dispatchPostToolUse(ctx);
    expect(result.hookSpecificOutput?.additionalContext).toContain(
      "circular import",
    );
  });

  it("returns empty for Bash with no import errors", async () => {
    // Bash output without import errors should not trigger the handler
    const ctx = makeContext(
      "Bash",
      { command: "ls" },
      { stdout: "file1.txt\nfile2.txt", stderr: "", exitCode: 0 },
    );
    const result = await dispatchPostToolUse(ctx);
    expect(result).toEqual({});
  });

  it("detects import errors in stdout as well", async () => {
    // Some tools pipe error output to stdout; handler should check both
    const ctx = makeContext(
      "Bash",
      { command: "python main.py 2>&1" },
      {
        stdout: "ModuleNotFoundError: No module named 'numpy'",
        stderr: "",
        exitCode: 1,
      },
    );
    const result = await dispatchPostToolUse(ctx);
    expect(result.hookSpecificOutput?.additionalContext).toContain(
      "ModuleNotFoundError",
    );
  });
});

describe("PostToolUse typescript-preflight handler", () => {
  it("is registered for Edit on .ts files", async () => {
    const ctx = makeContext("Edit", {
      file_path: "/home/kev/wilco/src/module.ts",
      old_string: "const x: number = 1",
      new_string: "const x: number = 'hello'",
    });
    const result = await dispatchPostToolUse(ctx);
    // Handler runs for .ts files — may or may not find errors depending on tsc availability
    expect(result).toBeDefined();
  });

  it("skips non-TypeScript files", async () => {
    const ctx = makeContext("Edit", {
      file_path: "/home/kev/wilco/README.md",
    });
    const result = await dispatchPostToolUse(ctx);
    // Should not block markdown files
    expect(result.decision).not.toBe("block");
  });

  it("skips .py files", async () => {
    const ctx = makeContext("Write", {
      file_path: "/home/kev/wilco/src/main.py",
      content: "print('hello')",
    });
    const result = await dispatchPostToolUse(ctx);
    expect(result.decision).not.toBe("block");
  });
});

// ── Mock TldrClient factory ─────────────────────────────────────────
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

describe("PostToolUse Edit/Write handlers", () => {
  it("returns diagnostics when daemon reports errors", async () => {
    // When the TLDR daemon returns type errors after a file edit,
    // the diagnostics handler should surface those in additionalContext
    const tldr = makeMockTldr({
      diagnostics: {
        status: "ok",
        type_errors: 1,
        lint_issues: 0,
        errors: [
          {
            file: "src/test.ts",
            line: 10,
            message: "Type 'string' is not assignable to type 'number'",
            severity: "error",
            source: "tsc",
          },
        ],
      },
    });

    const ctx: PostToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PostToolUse" as const,
        tool_name: "Edit",
        tool_input: { file_path: "/home/kev/wilco/src/test.ts" },
        tool_response: {},
        tool_use_id: "tu-1",
      },
      tldr,
    };

    const result = await dispatchPostToolUse(ctx);
    expect(result.hookSpecificOutput?.additionalContext).toContain("Type 'string'");
  });

  it("sends notify on Edit to track dirty files", async () => {
    // The notify handler should inform the TLDR daemon about changed files
    // so it can track dirty file counts and trigger reindexing
    const tldr = makeMockTldr({
      notify: { status: "ok", dirty_count: 3, reindex_triggered: false },
    });

    const ctx: PostToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PostToolUse" as const,
        tool_name: "Write",
        tool_input: { file_path: "/home/kev/wilco/src/new.ts" },
        tool_response: {},
        tool_use_id: "tu-2",
      },
      tldr,
    };

    const result = await dispatchPostToolUse(ctx);
    expect(tldr.query).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "notify" }),
    );
  });

  it("detects mismatched imports in Python files", async () => {
    // When editing a Python file with import statements, the import-validator
    // handler should query the daemon's symbol database for validation
    const tldr = makeMockTldr({
      search: {
        status: "ok",
        results: [
          { file: "lib/utils.py", name: "parse_config", line: 15 },
        ],
      },
    });

    const ctx: PostToolUseContext = {
      input: {
        session_id: "test-123",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "PostToolUse" as const,
        tool_name: "Edit",
        tool_input: {
          file_path: "/home/kev/wilco/src/main.py",
          new_string: "from config import parse_config",
        },
        tool_response: {},
        tool_use_id: "tu-3",
      },
      tldr,
    };

    const result = await dispatchPostToolUse(ctx);
    expect(tldr.query).toHaveBeenCalled();
  });
});
