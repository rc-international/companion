import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SessionEndInput, HookResponse } from "../hook-types.js";

const SKIP_LEARNINGS_REASONS = new Set(["clear", "logout"]);
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function handleSessionEnd(
  input: SessionEndInput,
): Promise<HookResponse> {
  const tasks: Promise<void>[] = [];

  // 1. Clean up old agent cache files (>7 days)
  tasks.push(cleanAgentCache(input.cwd));

  // 2. Log session end. Full learnings extraction stays as a command hook
  //    for now because it spawns LLM subprocesses. Moving LLM calls into
  //    Companion requires the model router (Phase 2).
  if (!SKIP_LEARNINGS_REASONS.has(input.reason)) {
    console.log(
      `[hooks] SessionEnd: session=${input.session_id.slice(-8)} reason=${input.reason} — learnings delegated to command hook`,
    );
  }

  await Promise.allSettled(tasks);

  return {};
}

async function cleanAgentCache(cwd: string): Promise<void> {
  const cacheDir = join(cwd, ".claude", "cache", "agents");
  if (!existsSync(cacheDir)) return;

  try {
    const entries = readdirSync(cacheDir);
    const now = Date.now();
    let cleaned = 0;
    for (const entry of entries) {
      const outputPath = join(cacheDir, entry, "latest-output.md");
      if (existsSync(outputPath)) {
        const stat = statSync(outputPath);
        if (now - stat.mtimeMs > CACHE_MAX_AGE_MS) {
          unlinkSync(outputPath);
          cleaned++;
        }
      }
    }
    if (cleaned > 0) {
      console.log(`[hooks] Cleaned ${cleaned} stale agent cache files`);
    }
  } catch (err) {
    console.warn("[hooks] Agent cache cleanup failed:", err);
  }
}
