import type { AiProvider, GenerateRequest, GenerateResponse, ToolCall } from "./types.js";

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

export class OpenRouterProvider implements AiProvider {
  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string
  ) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const model = request.model ?? this.defaultModel;
    const messages = request.messages.map(message => {
      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.toolResult?.toolCallId ?? "unknown",
          content: message.toolResult?.error
            ? JSON.stringify({ error: message.toolResult.error })
            : JSON.stringify(message.toolResult?.result ?? null)
        };
      }

      if (message.role === "assistant" && message.toolCalls?.length) {
        return {
          role: "assistant",
          content: message.content || null,
          tool_calls: message.toolCalls.map(call => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input ?? {})
            }
          }))
        };
      }

      return { role: message.role, content: message.content };
    });

    const tools = request.tools?.length
      ? request.tools.map(tool => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        }))
      : undefined;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(60000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        temperature: request.temperature
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenRouter request failed (${response.status}) using ${model}: ${detail.slice(0, 1000)}`);
    }

    const data = (await response.json()) as OpenRouterResponse;
    const message = data.choices?.[0]?.message;
    const text = message?.content ?? "";
    const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
      .filter(call => call.function?.name)
      .map((call, index) => {
        let input: unknown = {};
        let parseError: string | undefined;
        try {
          input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (error) {
          parseError = error instanceof Error ? `Invalid JSON tool arguments: ${error.message}` : "Invalid JSON tool arguments.";
        }
        return {
          id: call.id ?? `${call.function?.name}-${index}-${Date.now()}`,
          name: call.function!.name!,
          input,
          ...(parseError ? { parseError } : {})
        };
      });

    if (!text && toolCalls.length === 0) {
      throw new Error("OpenRouter returned no generated text or tool call.");
    }

    return { text, provider: "openrouter", model, toolCalls };
  }
}
