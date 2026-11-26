import { z } from "zod";
import { AgentCancelledError, AgentService } from "../agent/service.js";
import { AgentRunRepository } from "../agent/runs-repository.js";
import { AuthService } from "../auth/service.js";
import { config } from "../config.js";
import type { Task } from "../types/task.js";
import { PostgresTaskRepository } from "./task-repository.js";
import { TaskEventRepository } from "./task-events.js";

const agentTaskInputSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string().min(1)
    })
  ).min(1),
  model: z.string().trim().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxSteps: z.number().int().min(1).max(20).optional(),
  projectId: z.string().uuid().optional()
});

export class TaskWorker {
  private running = false;
  private activeExecutions = new Set<Promise<void>>();
  private lastCleanupAt = 0;

  constructor(
    private readonly repository: PostgresTaskRepository,
    private readonly pollMs = 1000,
    private readonly staleTaskMs = 300000,
    private readonly agentService = new AgentService(),
    private readonly events = new TaskEventRepository(),
    private readonly concurrency = config.WORKER_CONCURRENCY,
    private readonly runs = new AgentRunRepository(),
    private readonly auth = new AuthService()
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  async drain(): Promise<void> {
    this.running = false;
    await Promise.allSettled([...this.activeExecutions]);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.repository.recoverStaleRunningTasks(this.staleTaskMs);

        if (Date.now() - this.lastCleanupAt > 5 * 60 * 1000) {
          this.lastCleanupAt = Date.now();
          void this.auth.cleanupExpired().catch(() => {});
        }

        let claimedAny = false;
        while (this.running && this.activeExecutions.size < this.concurrency) {
          const task = await this.repository.claimNext();
          if (!task) break;
          claimedAny = true;
          await this.events.append(task.id, "task.running", { type: task.type });
          const execution = this.execute(task).finally(() => {
            this.activeExecutions.delete(execution);
          });
          this.activeExecutions.add(execution);
        }

        if (!claimedAny || this.activeExecutions.size >= this.concurrency) {
          await this.sleep(this.pollMs);
        }
      } catch (error) {
        console.error("Task worker error:", error);
        await this.sleep(this.pollMs);
      }
    }
  }

  private async execute(task: Task): Promise<void> {
    let agentRunId: string | undefined;
    try {
      if (task.type === "agent") {
        const parsed = agentTaskInputSchema.safeParse(task.input);
        if (!parsed.success) {
          throw new Error("Agent task input is invalid.");
        }

        if (task.userId) {
          const run = await this.runs.create({
            userId: task.userId,
            projectId: parsed.data.projectId,
            taskId: task.id,
            status: "running",
            input: parsed.data
          });
          agentRunId = run.id;
        }

        const result = await this.agentService.run({
          ...parsed.data,
          taskId: task.id,
          userId: task.userId,
          agentRunId,
          isCancelled: () => this.repository.isCancelRequested(task.id)
        });

        await this.repository.complete(task.id, result);
        if (agentRunId) await this.runs.complete(agentRunId, result);
        await this.events.append(task.id, "task.completed", { type: task.type });
        return;
      }

      const result = { status: "accepted", taskId: task.id, type: task.type };
      await this.repository.complete(task.id, result);
      await this.events.append(task.id, "task.completed", { type: task.type });
    } catch (error) {
      const cancelled = error instanceof AgentCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.repository.fail(task.id, message);
      if (agentRunId) {
        await this.runs.fail(agentRunId, { message }, cancelled ? "cancelled" : "failed");
      }
      await this.events.append(task.id, cancelled ? "task.cancelled" : "task.failed", { error: message });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
