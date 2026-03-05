import { spawnSync } from "node:child_process";
import type { PostToolUseInput, HookResponse } from "../hook-types.js";
import type { TldrClient } from "../tldr-client.js";

export interface PostToolUseContext {
  input: PostToolUseInput;
  tldr: TldrClient | null;
}

type Handler = (ctx: PostToolUseContext) => Promise<HookResponse | null>;

const handlers: Array<{ match: (tool: string) => boolean; handler: Handler }> =
  [];

function register(
  matcher: string | string[] | ((tool: string) => boolean),
  handler: Handler,
) {
  const matchFn =
    typeof matcher === "function"
      ? matcher
      : typeof matcher === "string"
        ? (t: string) => t === matcher
        : (t: string) => (matcher as string[]).includes(t);
  handlers.push({ match: matchFn, handler });
}

// -- Handler: import-error-detector (Bash) -----------------------------------
// Detects Python import errors in Bash command output and provides helpful
// context back to Claude so it can self-correct (install missing packages,
// fix circular imports, etc.)

const IMPORT_ERROR_PATTERNS = [
  /ModuleNotFoundError:\s*No module named '([\w.]+)'/,
  /ImportError:\s*cannot import name '([\w.]+)'/,
  /ImportError:\s*No module named '([\w.]+)'/,
  /circular import/i,
];

register("Bash", async (ctx) => {
  const stderr = String(ctx.input.tool_response?.stderr || "");
  const stdout = String(ctx.input.tool_response?.stdout || "");
  const output = stderr + stdout;

  const matches: string[] = [];
  for (const pattern of IMPORT_ERROR_PATTERNS) {
    const match = output.match(pattern);
    if (match) matches.push(match[0]);
  }

  if (matches.length === 0) return null;

  console.log(
    `[hooks] PostToolUse import-error-detector: found ${matches.length} import error(s)`,
  );

  return {
    hookSpecificOutput: {
      additionalContext: [
        "Import error detected in command output:",
        ...matches.map((m) => `  ${m}`),
        "",
        "Consider: check installed packages (pip list), verify import paths, check for circular imports.",
      ].join("\n"),
    },
  };
});

// ── Handler: post-edit-diagnostics (Edit|Write) ────────────────────
// Queries TLDR daemon for type errors and lint issues after file edits.

register(["Edit", "Write"], async (ctx) => {
  if (!ctx.tldr) return null;

  const filePath = String(
    ctx.input.tool_input?.file_path || ctx.input.tool_input?.path || "",
  );
  if (!filePath) return null;

  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext || !["py", "ts", "tsx", "js", "jsx"].includes(ext)) return null;

  const result = await ctx.tldr.safeQuery({
    cmd: "diagnostics",
    file: filePath,
  });

  if (!result.errors || result.errors.length === 0) return null;

  const preview = result.errors
    .slice(0, 5)
    .map(
      (e) =>
        `  ${e.file}:${e.line} [${e.severity}] ${e.message} (${e.source})`,
    )
    .join("\n");

  return {
    hookSpecificOutput: {
      additionalContext: `Diagnostics after edit:\n${preview}`,
    },
  };
});

// ── Handler: post-edit-notify (Edit|Write) ─────────────────────────
// Notifies TLDR daemon of file changes for dirty-file tracking.

register(["Edit", "Write"], async (ctx) => {
  if (!ctx.tldr) return null;

  const filePath = String(
    ctx.input.tool_input?.file_path || ctx.input.tool_input?.path || "",
  );
  if (!filePath) return null;

  const notifyResult = await ctx.tldr.query({ cmd: "notify", file: filePath });

  if (notifyResult.reindex_triggered) {
    return {
      hookSpecificOutput: {
        additionalContext: `[Semantic reindex triggered: ${notifyResult.dirty_count} files changed]`,
      },
    };
  }

  return null;
});

// ── Handler: import-validator (Edit|Write, Python only) ────────────
// Validates Python import statements against daemon symbol database.

const IMPORT_RE = /^from\s+([\w.]+)\s+import\s+(\w+)/gm;

register(["Edit", "Write"], async (ctx) => {
  if (!ctx.tldr) return null;

  const filePath = String(
    ctx.input.tool_input?.file_path || ctx.input.tool_input?.path || "",
  );
  if (!filePath.endsWith(".py")) return null;

  const newString = String(ctx.input.tool_input?.new_string || "");
  if (!newString) return null;

  const imports: Array<{ module: string; name: string }> = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(IMPORT_RE.source, IMPORT_RE.flags);
  while ((match = re.exec(newString)) !== null) {
    imports.push({ module: match[1], name: match[2] });
  }

  if (imports.length === 0) return null;

  const warnings: string[] = [];
  for (const imp of imports.slice(0, 5)) {
    const result = await ctx.tldr.safeQuery({
      cmd: "search",
      pattern: imp.name,
      max_results: 3,
    });

    if (result.results && result.results.length > 0) {
      const found = result.results[0] as { file?: string; name?: string };
      if (found.file && !found.file.includes(imp.module.replace(/\./g, "/"))) {
        warnings.push(
          `  ${imp.name}: imported from '${imp.module}' but found in '${found.file}'`,
        );
      }
    }
  }

  if (warnings.length === 0) return null;

  return {
    hookSpecificOutput: {
      additionalContext: `Import path warnings:\n${warnings.join("\n")}`,
    },
  };
});

// ── Handler: typescript-preflight (Edit|Write, .ts/.tsx only) ──────
// Runs quick TypeScript check after file edits.
// Note: Phase 3 will replace this with persistent tsc --watch.

const TS_EXTENSIONS = new Set(["ts", "tsx"]);

register(["Edit", "Write"], async (ctx) => {
  const filePath = String(
    ctx.input.tool_input?.file_path || ctx.input.tool_input?.path || "",
  );
  if (!filePath) return null;

  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext || !TS_EXTENSIONS.has(ext)) return null;

  try {
    const result = spawnSync(
      "npx",
      ["tsc", "--noEmit", "--pretty", "false", filePath],
      {
        cwd: ctx.input.cwd,
        timeout: 30000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const output = (result.stdout || "") + (result.stderr || "");
    if (result.status === 0 || !output.trim()) return null;

    const errors = output
      .split("\n")
      .filter((line) => line.includes("error TS"))
      .slice(0, 5);

    if (errors.length === 0) return null;

    return {
      decision: "block" as const,
      reason: `TypeScript errors found:\n${errors.join("\n")}\n\nFix these before proceeding.`,
    };
  } catch {
    return null;
  }
});

// -- Dispatcher --------------------------------------------------------------

export async function dispatchPostToolUse(
  ctx: PostToolUseContext,
): Promise<HookResponse> {
  const matching = handlers.filter((h) => h.match(ctx.input.tool_name));
  if (matching.length === 0) return {};

  const results = await Promise.allSettled(
    matching.map((h) => h.handler(ctx)),
  );

  return mergeResponses(results);
}

function mergeResponses(
  results: PromiseSettledResult<HookResponse | null>[],
): HookResponse {
  const contexts: string[] = [];
  const systemMessages: string[] = [];
  let blocked = false;
  let blockReason = "";

  for (const r of results) {
    if (r.status === "rejected") {
      console.warn("[hooks] PostToolUse handler error:", r.reason);
      continue;
    }
    const resp = r.value;
    if (!resp) continue;

    if (resp.decision === "block") {
      blocked = true;
      blockReason = resp.reason || blockReason;
    }

    const ctx =
      resp.hookSpecificOutput?.additionalContext ??
      (resp.hookSpecificOutput as Record<string, unknown>)?.additionalContext;
    if (typeof ctx === "string" && ctx.trim()) {
      contexts.push(ctx.trim());
    }

    if (resp.systemMessage) {
      systemMessages.push(resp.systemMessage);
    }
  }

  const response: HookResponse = {};
  if (blocked) {
    response.decision = "block";
    response.reason = blockReason;
  }
  if (contexts.length > 0) {
    response.hookSpecificOutput = {
      additionalContext: contexts.join("\n\n"),
    };
  }
  if (systemMessages.length > 0) {
    response.systemMessage = systemMessages.join("\n");
  }
  return response;
}
