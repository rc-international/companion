import pg from "pg";

const DATABASE_URL =
  process.env.WILCO_DATABASE_URL ||
  process.env.OPC_POSTGRES_URL ||
  "postgresql://claude:claude_dev@localhost:5432/continuous_claude";

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  }
  return pool;
}

export interface ActiveSession {
  id: string;
  working_on: string;
}

export async function registerSession(
  sessionId: string,
  project: string,
  workingOn: string,
): Promise<void> {
  try {
    const p = getPool();
    await p.query(
      `INSERT INTO sessions (id, project, working_on, last_heartbeat)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (id) DO UPDATE SET last_heartbeat = NOW(), working_on = $3`,
      [sessionId, project, workingOn],
    );
  } catch (err) {
    console.warn("[hooks] Failed to register session:", err);
  }
}

export async function getActiveSessions(
  project: string,
): Promise<ActiveSession[]> {
  try {
    const p = getPool();
    const result = await p.query(
      `SELECT id, COALESCE(working_on, '') as working_on
       FROM sessions
       WHERE project = $1 AND last_heartbeat > NOW() - INTERVAL '5 minutes'
       ORDER BY last_heartbeat DESC`,
      [project],
    );
    return result.rows;
  } catch (err) {
    console.warn("[hooks] Failed to get active sessions:", err);
    return [];
  }
}
