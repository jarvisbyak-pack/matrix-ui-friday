import { config } from "../config.js";
import { GeminiProvider } from "./gemini-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import type { AiProvider, GenerateRequest, GenerateResponse } from "./types.js";

function allowedModelsSet(): Set<string> {
  return new Set(
    config.ALLOWED_AI_MODELS.split(",")
      .map(value => value.trim())
      .filter(Boolean)
  );
}

class RoutingProvider implements AiProvider {
  constructor(
    private readonly gemini?: GeminiProvider,
    private readonly openrouter?: OpenRouterProvider
  ) {}

  generate(request: GenerateRequest): Promise<GenerateResponse> {
    const allowed = allowedModelsSet();
    if (request.model && allowed.size > 0 && !allowed.has(request.model)) {
      throw new Error(`Requested model '${request.model}' is not in ALLOWED_AI_MODELS.`);
    }

    const requestsOpenRouterPrefix = Boolean(
      request.model?.startsWith("z-ai/") || request.model?.startsWith("openrouter/")
    );
    const wantsOpenRouter = config.AI_PROVIDER === "openrouter" || requestsOpenRouterPrefix;

    if (wantsOpenRouter && config.AI_PROVIDER !== "openrouter" && !config.ALLOW_CROSS_PROVIDER_ROUTING) {
      throw new Error("Cross-provider model routing is disabled on this backend.");
    }

    if (wantsOpenRouter) {
      if (!this.openrouter) throw new Error("OPENROUTER_API_KEY is required for GLM/OpenRouter models.");
      return this.openrouter.generate({
        ...request,
        model: request.model?.replace(/^openrouter\//, "")
      });
    }

    if (!this.gemini) {
      throw new Error("GEMINI_API_KEY is required for Gemini models.");
    }
    return this.gemini.generate(request);
  }
}

export function createAiProvider(): AiProvider {
  if (!config.GEMINI_API_KEY && !config.OPENROUTER_API_KEY) {
    throw new Error("At least one AI provider API key is required.");
  }

  const gemini = config.GEMINI_API_KEY
    ? new GeminiProvider(config.GEMINI_API_KEY, config.GEMINI_MODEL, config.GEMINI_FALLBACK_MODEL)
    : undefined;

  const openrouter = config.OPENROUTER_API_KEY
    ? new OpenRouterProvider(config.OPENROUTER_API_KEY, config.OPENROUTER_MODEL)
    : undefined;

  if (config.AI_PROVIDER === "openrouter" && !openrouter) {
    throw new Error("OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter.");
  }
  if (config.AI_PROVIDER === "gemini" && !gemini) {
    throw new Error("GEMINI_API_KEY is required when AI_PROVIDER=gemini.");
  }

  return new RoutingProvider(gemini, openrouter);
}
