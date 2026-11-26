export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolResult?: ToolResult;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Gemini thought signature that must be preserved when replaying a function call. */
  thoughtSignature?: string;
  /** Parse error captured if the provider emitted malformed JSON tool arguments. */
  parseError?: string;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  result?: unknown;
  error?: string;
}

export interface GenerateRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  tools?: ToolDefinition[];
}

export interface GenerateResponse {
  text: string;
  provider: string;
  model: string;
  toolCalls: ToolCall[];
}

export interface AiProvider {
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}
