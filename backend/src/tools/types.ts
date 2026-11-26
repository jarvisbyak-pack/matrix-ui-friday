export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolExecutionContext {
  taskId?: string;
  userId?: string;
  userEmail?: string;
  projectId?: string;
  agentRunId?: string;
}

export interface Tool {
  definition: ToolDefinition;
  execute(input: unknown, context: ToolExecutionContext): Promise<unknown>;
}
