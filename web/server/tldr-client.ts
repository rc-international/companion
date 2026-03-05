import * as crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as net from "node:net";
import { join, resolve } from "node:path";

const QUERY_TIMEOUT = 3000;

/** Compute socket path: /tmp/tldr-{md5(resolved_path)[:8]}.sock */
export function getSocketPath(projectDir: string): string {
  const resolved = resolve(projectDir);
  const hash = crypto
    .createHash("md5")
    .update(resolved)
    .digest("hex")
    .substring(0, 8);
  return `/tmp/tldr-${hash}.sock`;
}

export interface DaemonQuery {
  cmd: string;
  [key: string]: unknown;
}

export interface DaemonResponse {
  status?: string;
  results?: unknown[];
  result?: unknown;
  callers?: unknown[];
  error?: string;
  indexing?: boolean;
  message?: string;
  type_errors?: number;
  lint_issues?: number;
  errors?: Array<{
    file: string;
    line: number;
    column?: number;
    message: string;
    severity: "error" | "warning";
    source: string;
  }>;
  reindex_triggered?: boolean;
  dirty_count?: number;
  imports?: unknown[];
  [key: string]: unknown;
}

/**
 * Persistent TLDR daemon client for a project directory.
 * Maintains connection info and provides async queries with timeout.
 */
export class TldrClient {
  private socketPath: string;
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = resolve(projectDir);
    this.socketPath = getSocketPath(this.projectDir);
  }

  /** Check if daemon is indexing via .tldr/status file */
  isIndexing(): boolean {
    const statusPath = join(this.projectDir, ".tldr", "status");
    try {
      if (existsSync(statusPath)) {
        return readFileSync(statusPath, "utf-8").trim() === "indexing";
      }
    } catch {
      // ignore
    }
    return false;
  }

  /** Check if socket file exists (fast pre-check) */
  isSocketPresent(): boolean {
    return existsSync(this.socketPath);
  }

  /** Send a query to the daemon via Unix socket */
  async query(q: DaemonQuery): Promise<DaemonResponse> {
    if (this.isIndexing()) {
      return {
        indexing: true,
        status: "indexing",
        message: "Daemon is indexing",
      };
    }

    if (!this.isSocketPresent()) {
      return { status: "unavailable", error: "Socket not found" };
    }

    return new Promise((res) => {
      const client = new net.Socket();
      let data = "";
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          client.destroy();
          res({ status: "error", error: "timeout" });
        }
      }, QUERY_TIMEOUT);

      client.connect(this.socketPath, () => {
        client.write(`${JSON.stringify(q)}\n`);
      });

      client.on("data", (chunk) => {
        data += chunk.toString();
        // Try to parse complete JSON
        try {
          const parsed = JSON.parse(data.trim());
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            client.destroy();
            res(parsed);
          }
        } catch {
          // Wait for more data
        }
      });

      client.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          res({ status: "unavailable", error: err.message });
        }
      });

      client.on("close", () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          if (data) {
            try {
              res(JSON.parse(data.trim()));
            } catch {
              res({ status: "error", error: "Incomplete response" });
            }
          } else {
            res({ status: "error", error: "Connection closed" });
          }
        }
      });
    });
  }

  /** Convenience: query with graceful fallback */
  async safeQuery(q: DaemonQuery): Promise<DaemonResponse> {
    try {
      return await this.query(q);
    } catch {
      return { status: "error", error: "Query failed" };
    }
  }
}

/** Cache of TldrClient instances per project directory */
const clientCache = new Map<string, TldrClient>();

/** Get or create a TldrClient for a project directory */
export function getTldrClient(projectDir: string): TldrClient {
  const resolved = resolve(projectDir);
  let client = clientCache.get(resolved);
  if (!client) {
    client = new TldrClient(resolved);
    clientCache.set(resolved, client);
  }
  return client;
}
