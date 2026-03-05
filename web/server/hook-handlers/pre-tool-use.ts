import type { PreToolUseInput, HookResponse } from "../hook-types.js";
import type { TldrClient } from "../tldr-client.js";
import type pg from "pg";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PreToolUseContext {
  input: PreToolUseInput;
  tldr: TldrClient | null;
  db: pg.Pool | null;
}

type Handler = (ctx: PreToolUseContext) => Promise<HookResponse | null>;

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

// ── Handler: path-rules (Read|Edit|Write) ──────────────────────────
// Matches file paths against regex rules and injects skill content.

interface PathRule {
  pattern: RegExp;
  skillFile: string;
  description: string;
}

const PATH_RULES: PathRule[] = [
  {
    pattern: /hooks\/src\//,
    skillFile: "hook-developer",
    description: "Hook development",
  },
  {
    pattern: /\.claude\/rules\//,
    skillFile: "skill-developer",
    description: "Skill/rule development",
  },
  {
    pattern: /companion\/web\/server\//,
    skillFile: "companion-dev",
    description: "Companion server development",
  },
  {
    pattern: /companion\/web\/src\//,
    skillFile: "companion-frontend",
    description: "Companion frontend development",
  },
  {
    pattern: /scripts\//,
    skillFile: "infrastructure",
    description: "Infrastructure scripts",
  },
];

register(["Read", "Edit", "Write"], async (ctx) => {
  const filePath = String(
    ctx.input.tool_input?.file_path || ctx.input.tool_input?.path || "",
  );
  if (!filePath) return null;

  for (const rule of PATH_RULES) {
    if (rule.pattern.test(filePath)) {
      const skillPaths = [
        join(ctx.input.cwd, ".claude", "skills", `${rule.skillFile}.md`),
        join(
          process.env.HOME || "",
          ".claude",
          "skills",
          `${rule.skillFile}.md`,
        ),
      ];

      for (const sp of skillPaths) {
        if (existsSync(sp)) {
          try {
            const content = readFileSync(sp, "utf-8");
            return { systemMessage: content.slice(0, 2000) };
          } catch {
            // ignore read errors
          }
        }
      }

      console.log(
        `[hooks] path-rules: matched ${rule.description} for ${filePath}`,
      );
    }
  }

  return null;
});

// ── Handler: file-claims (Edit) ────────────────────────────────────
// Tracks which session is editing which file. Warns on conflicts.

register("Edit", async (ctx) => {
  if (!ctx.db) return null;

  const filePath = String(ctx.input.tool_input?.file_path || "");
  if (!filePath) return null;

  try {
    const existing = await ctx.db.query(
      `SELECT session_id, claimed_at FROM file_claims
       WHERE file_path = $1 AND session_id != $2
       AND claimed_at > NOW() - INTERVAL '30 minutes'
       ORDER BY claimed_at DESC LIMIT 1`,
      [filePath, ctx.input.session_id],
    );

    await ctx.db.query(
      `INSERT INTO file_claims (file_path, session_id, claimed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (file_path) DO UPDATE SET session_id = $2, claimed_at = NOW()`,
      [filePath, ctx.input.session_id],
    );

    if (existing.rows.length > 0) {
      const other = existing.rows[0];
      return {
        hookSpecificOutput: {
          additionalContext: `Warning: session ${String(other.session_id).slice(-8)} also edited ${filePath} (${Math.round((Date.now() - new Date(other.claimed_at).getTime()) / 60000)}m ago). Coordinate to avoid conflicts.`,
        },
      };
    }
  } catch (err) {
    console.warn("[hooks] file-claims error:", err);
  }

  return null;
});

// ── Handler: edit-context-inject (Edit) ────────────────────────────
// Injects compact symbol + dependency summary for the file being edited.

register("Edit", async (ctx) => {
  if (!ctx.tldr) return null;

  const filePath = String(ctx.input.tool_input?.file_path || "");
  if (!filePath) return null;

  const [extractResult, importsResult] = await Promise.all([
    ctx.tldr.safeQuery({ cmd: "extract", file: filePath }),
    ctx.tldr.safeQuery({ cmd: "imports", file: filePath }),
  ]);

  const parts: string[] = [];

  if (extractResult.result) {
    const r = extractResult.result as {
      symbols?: string[];
      imports?: string[];
    };
    if (r.symbols && r.symbols.length > 0) {
      parts.push(`Symbols: ${r.symbols.slice(0, 10).join(", ")}`);
    }
  }

  if (
    importsResult.imports &&
    Array.isArray(importsResult.imports) &&
    importsResult.imports.length > 0
  ) {
    const deps = (importsResult.imports as Array<{ module?: string }>)
      .slice(0, 5)
      .map((i) => i.module || "unknown")
      .join(", ");
    parts.push(`Dependencies: ${deps}`);
  }

  if (parts.length === 0) return null;

  return {
    hookSpecificOutput: {
      additionalContext: `File context for ${filePath.split("/").pop()}:\n${parts.join("\n")}`,
    },
  };
});

// ── Handler: signature-helper (Edit) ───────────────────────────────
// Looks up function signatures referenced in the new_string.

const FUNC_CALL_RE = /\b([a-zA-Z_]\w*)\s*\(/g;

const SKIP_NAMES = new Set([
  "if", "for", "while", "return", "print", "len", "str", "int", "dict", "list",
  "set", "type", "range", "super", "self", "cls", "import", "from", "class",
  "def", "async", "await", "yield", "lambda", "not", "and", "or", "in", "is",
  "try", "except", "finally", "with", "as", "raise", "assert", "del", "pass",
  "break", "continue", "global", "nonlocal", "elif", "else", "True", "False",
  "None", "typeof", "instanceof", "new", "const", "let", "var", "function",
  "export", "require", "console", "Math", "JSON", "Object", "Array", "String",
  "Number", "Boolean", "Promise", "Error", "Map", "Set", "Date", "RegExp", "Symbol",
]);

register("Edit", async (ctx) => {
  if (!ctx.tldr) return null;

  const newString = String(ctx.input.tool_input?.new_string || "");
  if (!newString || newString.length < 10) return null;

  const funcNames = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(FUNC_CALL_RE.source, FUNC_CALL_RE.flags);
  while ((match = re.exec(newString)) !== null) {
    const name = match[1];
    if (!SKIP_NAMES.has(name)) {
      funcNames.add(name);
    }
  }

  if (funcNames.size === 0) return null;

  const signatures: string[] = [];
  for (const name of Array.from(funcNames).slice(0, 5)) {
    const result = await ctx.tldr.safeQuery({
      cmd: "search",
      pattern: name,
      max_results: 1,
    });

    if (result.results && result.results.length > 0) {
      const found = result.results[0] as {
        file?: string;
        name?: string;
        signature?: string;
        line?: number;
      };
      if (found.signature) {
        signatures.push(`  ${found.name}: ${found.signature}`);
      } else if (found.file && found.line) {
        signatures.push(`  ${found.name}: ${found.file}:${found.line}`);
      }
    }
  }

  if (signatures.length === 0) return null;

  return {
    hookSpecificOutput: {
      additionalContext: `Function signatures:\n${signatures.join("\n")}`,
    },
  };
});

// ── Handler: smart-search-router (Grep) ────────────────────────────
// Classifies grep queries as structural/semantic/literal and routes accordingly.

const SEMANTIC_INDICATORS = [
  /^(how|why|what|where|when|which|find|show|list|get|explain)\s/i,
  /\s(related to|similar to|about|for|that|which)\s/i,
  /\s(pattern|concept|approach|strategy|method)\s*$/i,
];

const STRUCTURAL_INDICATORS = [
  /^(class|def|function|interface|type|struct|enum|const|let|var|export)\s/,
  /^[A-Z][a-zA-Z]+\s*[({<]/,
  /^\w+\.\w+\(/,
];

register("Grep", async (ctx) => {
  const pattern = String(ctx.input.tool_input?.pattern || "");
  if (!pattern) return null;

  const isSemantic = SEMANTIC_INDICATORS.some((re) => re.test(pattern));
  const isStructural = STRUCTURAL_INDICATORS.some((re) => re.test(pattern));

  if (!isSemantic && !isStructural) return null;

  if (!ctx.tldr) return null;

  if (isSemantic) {
    const result = await ctx.tldr.safeQuery({
      cmd: "semantic",
      action: "search",
      query: pattern,
      k: 10,
    });

    if (result.results && (result.results as unknown[]).length > 0) {
      const formatted = (result.results as Array<{ file?: string; line?: number; text?: string }>)
        .slice(0, 10)
        .map((r) => `  ${r.file || "?"}:${r.line || "?"} — ${(r.text || "").slice(0, 100)}`)
        .join("\n");

      return {
        decision: "block" as const,
        reason: `Semantic search results (more relevant than grep for this query):\n${formatted}`,
      };
    }
  }

  if (isStructural) {
    const result = await ctx.tldr.safeQuery({
      cmd: "search",
      pattern,
      max_results: 10,
    });

    if (result.results && (result.results as unknown[]).length > 0) {
      const formatted = (result.results as Array<{ file?: string; name?: string; line?: number }>)
        .slice(0, 10)
        .map((r) => `  ${r.file || "?"}:${r.line || "?"} — ${r.name || "?"}`)
        .join("\n");

      return {
        decision: "block" as const,
        reason: `Structural search results (faster than grep for definitions):\n${formatted}`,
      };
    }
  }

  return null;
});

// ── Handler: tldr-read-enforcer (Read) ─────────────────────────────
// For large code files, provides TLDR summary instead of raw content.

const CODE_EXTENSIONS = new Set(["py", "ts", "tsx", "js", "jsx", "go", "rs"]);
const SKIP_PATTERNS = [
  /test[_s]?\./i,
  /\.test\./,
  /\.spec\./,
  /\/tests?\//,
  /config/i,
  /\.json$/,
  /\.md$/,
  /\.yml$/,
  /\.yaml$/,
  /\.toml$/,
  /\/hooks?\//,
  /\/skills?\//,
  /\.env/,
  /package\.json/,
  /tsconfig/,
  /\.lock$/,
];

register("Read", async (ctx) => {
  if (!ctx.tldr) return null;

  const filePath = String(ctx.input.tool_input?.file_path || "");
  if (!filePath) return null;

  if (ctx.input.tool_input?.offset || ctx.input.tool_input?.limit) return null;

  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (!CODE_EXTENSIONS.has(ext)) return null;

  if (SKIP_PATTERNS.some((p) => p.test(filePath))) return null;

  const result = await ctx.tldr.safeQuery({ cmd: "extract", file: filePath });

  if (!result.result) return null;

  const r = result.result as {
    symbols?: string[];
    lines?: number;
    imports?: string[];
  };

  if (!r.lines || r.lines < 100) return null;

  const parts: string[] = [`TLDR summary of ${filePath.split("/").pop()} (${r.lines} lines):`];

  if (r.symbols && r.symbols.length > 0) {
    parts.push(`Symbols: ${r.symbols.join(", ")}`);
  }
  if (r.imports && r.imports.length > 0) {
    parts.push(`Imports: ${r.imports.slice(0, 10).join(", ")}`);
  }

  return {
    decision: "block" as const,
    reason: parts.join("\n") + "\n\nUse Read with offset/limit to read specific sections, or Grep to find specific code.",
  };
});

// ── Handler: tldr-context-inject (Task) ────────────────────────────
// Injects TLDR code analysis layers into Task/Agent prompts.

const DEBUG_KEYWORDS = /debug|investigate|trace|diagnose|error|bug|fix|issue/i;

register("Task", async (ctx) => {
  if (!ctx.tldr) return null;

  const prompt = String(ctx.input.tool_input?.prompt || "");
  if (!prompt || prompt.length < 20) return null;

  const result = await ctx.tldr.safeQuery({ cmd: "context", entry: prompt.slice(0, 100) });

  if (!result.result) return null;

  const r = result.result as {
    call_graph?: string;
    symbols?: string[];
    cfg?: string;
    dfg?: string;
  };

  const parts: string[] = [];
  if (r.call_graph) parts.push(`Call graph:\n${r.call_graph}`);
  if (r.symbols && r.symbols.length > 0) {
    parts.push(`Relevant symbols: ${r.symbols.slice(0, 15).join(", ")}`);
  }
  if (r.cfg) parts.push(`Control flow:\n${r.cfg}`);
  if (r.dfg) parts.push(`Data flow:\n${r.dfg}`);

  if (parts.length === 0) return null;

  return {
    hookSpecificOutput: {
      additionalContext: `Code analysis context:\n${parts.join("\n\n")}`,
    },
  };
});

// ── Handler: arch-context-inject (Task) ────────────────────────────
// Injects architecture map for planning/design Task calls.

const PLANNING_KEYWORDS = /plan|design|refactor|restructure|architect|reorganize|module|layer/i;

register("Task", async (ctx) => {
  if (!ctx.tldr) return null;

  const prompt = String(ctx.input.tool_input?.prompt || "");
  if (!prompt || !PLANNING_KEYWORDS.test(prompt)) return null;

  const result = await ctx.tldr.safeQuery({ cmd: "arch" });

  if (!result.result) return null;

  const r = result.result as {
    entry_layer?: string[];
    leaf_layer?: string[];
    circular?: Array<{ from: string; to: string }>;
  };

  const parts: string[] = ["Architecture map:"];
  if (r.entry_layer && r.entry_layer.length > 0) {
    parts.push(`  Entry points: ${r.entry_layer.join(", ")}`);
  }
  if (r.leaf_layer && r.leaf_layer.length > 0) {
    parts.push(`  Leaf modules: ${r.leaf_layer.join(", ")}`);
  }
  if (r.circular && r.circular.length > 0) {
    parts.push(
      `  Circular deps: ${r.circular.map((c) => `${c.from} <-> ${c.to}`).join(", ")}`,
    );
  }

  return {
    hookSpecificOutput: {
      additionalContext: parts.join("\n"),
    },
  };
});

/**
 * Dispatch a PreToolUse event to matching handlers.
 * Runs all matching handlers in parallel, merges responses.
 * If any handler returns decision: "block", the tool call is denied.
 */
export async function dispatchPreToolUse(
  ctx: PreToolUseContext,
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
      console.warn("[hooks] PreToolUse handler error:", r.reason);
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
