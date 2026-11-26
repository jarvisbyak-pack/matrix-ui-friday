import { config } from "../config.js";

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  markdown?: string;
}

interface FirecrawlSearchResponse {
  success?: boolean;
  web?: Array<{
    title?: unknown;
    url?: unknown;
    description?: unknown;
    markdown?: unknown;
  }>;
  data?: {
    web?: Array<{
      title?: unknown;
      url?: unknown;
      description?: unknown;
      markdown?: unknown;
    }>;
  };
  error?: string;
}

export class WebSearchService {
  async search(
    query: string,
    limit = 5,
    timeoutMs = config.FIRECRAWL_SEARCH_TIMEOUT_MS,
    apiKeyOverride?: string
  ): Promise<{
    query: string;
    results: WebSearchResult[];
  }> {
    const apiKey = apiKeyOverride || config.FIRECRAWL_API_KEY;
    if (!apiKey) {
      throw new Error("Web search is not configured. Set FIRECRAWL_API_KEY on the Friday backend.");
    }

    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error("Search query must not be empty.");

    const boundedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 10) : 5;
    const boundedTimeout = Number.isFinite(timeoutMs)
      ? Math.min(Math.max(Math.trunc(timeoutMs), 1000), 60000)
      : config.FIRECRAWL_SEARCH_TIMEOUT_MS;
    const endpoint = new URL("search", `${config.FIRECRAWL_API_URL.replace(/\/$/, "")}/`).toString();

    const response = await fetch(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(boundedTimeout),
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "Friday-Agent/0.1"
      },
      body: JSON.stringify({
        query: normalizedQuery,
        limit: boundedLimit,
        scrapeOptions: { formats: ["markdown"] }
      })
    });

    const raw = await response.text();
    let payload: FirecrawlSearchResponse = {};
    try {
      payload = raw ? JSON.parse(raw) as FirecrawlSearchResponse : {};
    } catch {
      throw new Error(`Web search returned an invalid response (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const detail = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
      throw new Error(`Web search failed: ${detail}`);
    }

    const candidates = payload.web ?? payload.data?.web ?? [];
    const results = candidates
      .map(item => ({
        title: typeof item.title === "string" ? item.title.trim() : "",
        url: typeof item.url === "string" ? item.url.trim() : "",
        description: typeof item.description === "string" ? item.description.trim() : "",
        ...(typeof item.markdown === "string" && item.markdown.trim()
          ? { markdown: item.markdown.trim() }
          : {})
      }))
      .filter(item => item.url && /^https?:\/\//i.test(item.url))
      .slice(0, boundedLimit);

    return { query: normalizedQuery, results };
  }
}
