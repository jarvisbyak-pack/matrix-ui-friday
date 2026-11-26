import { AiService } from "../ai/service.js";
import type { AiProvider, ChatMessage, ToolCall, ToolResult } from "../ai/types.js";
import type { ToolKey } from "../credentials/service.js";
import { ProjectRepository } from "../projects/repository.js";
import { createDefaultToolRegistry } from "../tools/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import { TaskEventRepository } from "../tasks/task-events.js";
import { AgentRunRepository } from "./runs-repository.js";
import type { AgentRequest, AgentResult } from "./types.js";

const DEFAULT_MAX_STEPS = 8;

export class AgentCancelledError extends Error {
  constructor(message = "Task cancelled by user.") {
    super(message);
    this.name = "AgentCancelledError";
  }
}

function projectToolKeyForName(toolName: string): ToolKey | undefined {
  if (toolName.startsWith("github.")) return "github";
  if (toolName === "web.fetch") return "web";
  if (toolName === "web.search") return "firecrawl";
  if (toolName.startsWith("files.")) return "files";
  if (toolName === "code.run") return "sandbox";
  return undefined;
}

export class AgentService {
  constructor(
    private readonly aiService: AiProvider = new AiService(),
    private readonly registry: ToolRegistry = createDefaultToolRegistry(),
    private readonly events = new TaskEventRepository(),
    private readonly projects = new ProjectRepository(),
    private readonly runs = new AgentRunRepository()
  ) {}

  private async logRun(
    request: AgentRequest,
    level: "debug" | "info" | "warn" | "error",
    eventType: string,
    message: string,
    payload?: unknown
  ): Promise<void> {
    if (!request.agentRunId) return;
    await this.runs.appendLog(request.agentRunId, { level, eventType, message, payload });
  }

  private async assertNotCancelled(request: AgentRequest): Promise<void> {
    if (request.isCancelled && await request.isCancelled()) {
      throw new AgentCancelledError();
    }
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const maxSteps = request.maxSteps ?? DEFAULT_MAX_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 20) {
      throw new Error("maxSteps must be an integer between 1 and 20.");
    }

    const messages: ChatMessage[] = [...request.messages];
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];

    for (let step = 1; step <= maxSteps; step += 1) {
      await this.assertNotCancelled(request);
      if (request.taskId) await this.events.append(request.taskId, "agent.step.started", { step, maxSteps });
      await this.logRun(request, "info", "agent.step.started", `Starting step ${step} of ${maxSteps}`, { step, maxSteps });

      const response = await this.aiService.generate({
        messages,
        model: request.model,
        temperature: request.temperature,
        tools: this.registry.list().map(tool => tool.definition)
      });

      messages.push({
        role: "assistant",
        content: response.text,
        ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {})
      });

      if (response.toolCalls.length === 0) {
        if (request.taskId) await this.events.append(request.taskId, "agent.completed", { step });
        await this.logRun(request, "info", "agent.completed", `Agent completed in ${step} step(s)`, { step });
        return {
          text: response.text,
          model: response.model,
          provider: response.provider,
          steps: step,
          toolCalls,
          toolResults
        };
      }

      for (const call of response.toolCalls) {
        await this.assertNotCancelled(request);
        toolCalls.push(call);
        if (request.taskId) {
          await this.events.append(request.taskId, "agent.tool.started", {
            step,
            toolCallId: call.id,
            name: call.name
          });
        }
        await this.logRun(request, "info", "agent.tool.started", `Executing tool ${call.name}`, {
          step,
          toolCallId: call.id,
          name: call.name
        });

        try {
          if (call.parseError) {
            throw new Error(call.parseError);
          }

          if (request.projectId) {
            const toolKey = projectToolKeyForName(call.name);
            if (toolKey) {
              const enabled = await this.projects.isToolEnabled(request.projectId, toolKey);
              if (enabled === false) {
                throw new Error(`Tool '${toolKey}' is disabled for this project.`);
              }
            }
          }

          const result = await this.registry.execute(call.name, call.input, {
            taskId: request.taskId,
            userId: request.userId,
            userEmail: request.userEmail,
            projectId: request.projectId,
            agentRunId: request.agentRunId
          });
          const toolResult: ToolResult = { toolCallId: call.id, name: call.name, result };
          toolResults.push(toolResult);
          messages.push({ role: "tool", content: JSON.stringify(toolResult), toolResult });
          if (request.taskId) {
            await this.events.append(request.taskId, "agent.tool.completed", {
              step,
              toolCallId: call.id,
              name: call.name
            });
          }
          await this.logRun(request, "info", "agent.tool.completed", `Tool ${call.name} succeeded`, {
            step,
            toolCallId: call.id,
            name: call.name
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const toolResult: ToolResult = { toolCallId: call.id, name: call.name, error: message };
          toolResults.push(toolResult);
          messages.push({ role: "tool", content: JSON.stringify(toolResult), toolResult });
          if (request.taskId) {
            await this.events.append(request.taskId, "agent.tool.failed", {
              step,
              toolCallId: call.id,
              name: call.name,
              error: message
            });
          }
          await this.logRun(request, "warn", "agent.tool.failed", `Tool ${call.name} failed: ${message}`, {
            step,
            toolCallId: call.id,
            name: call.name,
            error: message
          });
        }
      }
    }

    if (request.taskId) await this.events.append(request.taskId, "agent.max_steps", { maxSteps });
    await this.logRun(request, "error", "agent.max_steps", `Reached maximum step limit of ${maxSteps}`, { maxSteps });
    throw new Error(`Agent reached the maximum step limit of ${maxSteps}.`);
  }
}
