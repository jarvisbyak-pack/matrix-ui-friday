import { pool } from "../db/pool.js";

export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ExecutionLogLevel = "debug" | "info" | "warn" | "error";

export type AgentRun = {
  id: string;
  userId: string;
  projectId?: string;
  taskId?: string;
  status: AgentRunStatus;
  input?: unknown;
  result?: unknown;
  error?: unknown;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionLog = {
  id: number;
  agentRunId: string;
  sequence: number;
  level: ExecutionLogLevel;
  eventType: string;
  message: string;
  payload?: unknown;
  createdAt: string;
};

type AgentRunRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  task_id: string | null;
  status: AgentRunStatus;
  input: unknown;
  result: unknown;
  error: unknown;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ExecutionLogRow = {
  id: number;
  agent_run_id: string;
  sequence: string;
  level: ExecutionLogLevel;
  event_type: string;
  message: string;
  payload: unknown;
  created_at: Date;
};

function toAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    status: row.status,
    ...(row.input === null ? {} : { input: row.input }),
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at.toISOString() }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.toISOString() }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function toExecutionLog(row: ExecutionLogRow): ExecutionLog {
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    sequence: Number(row.sequence),
    level: row.level,
    eventType: row.event_type,
    message: row.message,
    ...(row.payload === null ? {} : { payload: row.payload }),
    createdAt: row.created_at.toISOString()
  };
}

export class AgentRunRepository {
  async create(input: {
    userId: string;
    projectId?: string;
    taskId?: string;
    status?: AgentRunStatus;
    input?: unknown;
  }): Promise<AgentRun> {
    const status = input.status ?? "queued";
    const { rows } = await pool.query<AgentRunRow>(
      `INSERT INTO agent_runs (user_id, project_id, task_id, status, input, started_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, CASE WHEN $4 = 'running' THEN NOW() ELSE NULL END)
       RETURNING id, user_id, project_id, task_id, status, input, result, error,
                 started_at, completed_at, created_at, updated_at`,
      [
        input.userId,
        input.projectId ?? null,
        input.taskId ?? null,
        status,
        JSON.stringify(input.input ?? null)
      ]
    );
    return toAgentRun(rows[0]!);
  }

  async markRunning(id: string): Promise<void> {
    await pool.query(
      `UPDATE agent_runs
       SET status = 'running', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  async complete(id: string, result: unknown): Promise<void> {
    await pool.query(
      `UPDATE agent_runs
       SET status = 'completed',
           result = $2::jsonb,
           error = NULL,
           started_at = COALESCE(started_at, NOW()),
           completed_at = GREATEST(NOW(), COALESCE(started_at, NOW())),
           updated_at = NOW()
       WHERE id = $1`,
      [id, JSON.stringify(result ?? null)]
    );
  }

  async fail(id: string, error: unknown, status: "failed" | "cancelled" = "failed"): Promise<void> {
    await pool.query(
      `UPDATE agent_runs
       SET status = $2,
           error = $3::jsonb,
           started_at = COALESCE(started_at, NOW()),
           completed_at = GREATEST(NOW(), COALESCE(started_at, NOW())),
           updated_at = NOW()
       WHERE id = $1`,
      [id, status, JSON.stringify(error ?? null)]
    );
  }

  async list(userId: string, limit = 50): Promise<AgentRun[]> {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 50;
    const { rows } = await pool.query<AgentRunRow>(
      `SELECT id, user_id, project_id, task_id, status, input, result, error,
              started_at, completed_at, created_at, updated_at
       FROM agent_runs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, safeLimit]
    );
    return rows.map(toAgentRun);
  }

  async get(userId: string, id: string): Promise<AgentRun | undefined> {
    const { rows } = await pool.query<AgentRunRow>(
      `SELECT id, user_id, project_id, task_id, status, input, result, error,
              started_at, completed_at, created_at, updated_at
       FROM agent_runs
       WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rows[0] ? toAgentRun(rows[0]) : undefined;
  }

  async appendLog(
    agentRunId: string,
    entry: {
      level?: ExecutionLogLevel;
      eventType: string;
      message: string;
      payload?: unknown;
    }
  ): Promise<ExecutionLog> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [agentRunId]);
      const { rows } = await client.query<ExecutionLogRow>(
        `INSERT INTO execution_logs (agent_run_id, sequence, level, event_type, message, payload)
         VALUES (
           $1,
           COALESCE((SELECT MAX(sequence) + 1 FROM execution_logs WHERE agent_run_id = $1), 1),
           $2,
           $3,
           $4,
           $5::jsonb
         )
         RETURNING id, agent_run_id, sequence, level, event_type, message, payload, created_at`,
        [
          agentRunId,
          entry.level ?? "info",
          entry.eventType,
          entry.message,
          JSON.stringify(entry.payload ?? null)
        ]
      );
      await client.query("COMMIT");
      return toExecutionLog(rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listLogs(userId: string, agentRunId: string, afterSequence = 0, limit = 200): Promise<ExecutionLog[] | undefined> {
    const run = await this.get(userId, agentRunId);
    if (!run) return undefined;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 200;
    const safeAfter = Number.isFinite(afterSequence) ? Math.max(Math.trunc(afterSequence), 0) : 0;
    const { rows } = await pool.query<ExecutionLogRow>(
      `SELECT id, agent_run_id, sequence, level, event_type, message, payload, created_at
       FROM execution_logs
       WHERE agent_run_id = $1 AND sequence > $2
       ORDER BY sequence ASC
       LIMIT $3`,
      [agentRunId, safeAfter, safeLimit]
    );
    return rows.map(toExecutionLog);
  }
}
