import type { AiProvider, GenerateRequest, GenerateResponse, ToolCall } from "./types.js";

type GeminiPart = {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: Record<string, unknown> };
};

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type GeminiCandidate = {
  content?: { parts?: GeminiPart[] };
};

export class GeminiProvider implements AiProvider {
  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string,
    private readonly fallbackModel?: string
  ) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const model = request.model ?? this.defaultModel;
    const contents: GeminiContent[] = [];

    for (const message of request.messages) {
      if (message.role === "system") continue;

      if (message.role === "tool") {
        const toolResult = message.toolResult;
        const part: GeminiPart = {
          functionResponse: {
            name: toolResult?.name ?? "unknown",
            response: toolResult?.error
              ? { error: toolResult.error }
              : { result: toolResult?.result ?? null }
          }
        };
        const last = contents[contents.length - 1];
        if (last && last.role === "user" && last.parts.every(p => Boolean(p.functionResponse))) {
          last.parts.push(part);
        } else {
          contents.push({ role: "user", parts: [part] });
        }
        continue;
      }

      if (message.role === "assistant" && message.toolCalls?.length) {
        contents.push({
          role: "model",
          parts: [
            ...(message.content ? [{ text: message.content }] : []),
            ...message.toolCalls.map(call => ({
              functionCall: {
                name: call.name,
                args: call.input && typeof call.input === "object"
                  ? call.input as Record<string, unknown>
                  : {}
              },
              ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
            }))
          ]
        });
        continue;
      }

      contents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }]
      });
    }

    const functionDeclarations = request.tools?.length
      ? request.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.inputSchema
        }))
      : undefined;

    const systemParts = request.messages
      .filter(message => message.role === "system" && message.content.trim().length > 0)
      .map(message => ({ text: message.content }));

    const models = [model, ...(this.fallbackModel && this.fallbackModel !== model ? [this.fallbackModel] : [])];
    let response: Response | undefined;
    let lastDetail = "";
    let activeModel = model;

    for (const candidateModel of models) {
      activeModel = candidateModel;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidateModel)}:generateContent`,
          {
            method: "POST",
            signal: AbortSignal.timeout(60000),
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": this.apiKey
            },
            body: JSON.stringify({
              contents,
              systemInstruction: systemParts.length > 0
                ? { parts: systemParts }
                : undefined,
              tools: functionDeclarations ? [{ functionDeclarations }] : undefined,
              generationConfig:
                request.temperature === undefined ? undefined : { temperature: request.temperature }
            })
          }
        );

        if (response.ok) break;

        lastDetail = await response.text();
        if (![429, 500, 502, 503, 504].includes(response.status)) break;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 750 * (attempt + 1)));
      }

      if (response?.ok) break;
      if (response && ![404, 429, 500, 502, 503, 504].includes(response.status)) break;
    }

    if (!response?.ok) {
      throw new Error(`Gemini request failed (${response?.status ?? 503}) using ${activeModel}: ${lastDetail.slice(0, 1000)}`);
    }

    const data = (await response.json()) as { candidates?: GeminiCandidate[] };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map(part => part.text ?? "").join("");
    const toolCalls: ToolCall[] = [];

    for (const [index, part] of parts.entries()) {
      if (part.functionCall?.name) {
        toolCalls.push({
          id: `${part.functionCall.name}-${index}-${Date.now()}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
        });
      }
    }

    if (!text && toolCalls.length === 0) {
      throw new Error("Gemini returned no generated text or tool call.");
    }

    return { text, provider: "gemini", model: activeModel, toolCalls };
  }
}
