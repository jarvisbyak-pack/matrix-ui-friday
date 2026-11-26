import { config } from "../config.js";

type GitHubResponse<T> = {
  data: T;
  headers: Headers;
};

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;

function normalizeRepo(repo: string): string {
  const trimmed = repo.trim();
  if (!REPO_PATTERN.test(trimmed)) {
    throw new Error("repo must be formatted as owner/name.");
  }
  const [owner, name] = trimmed.split("/") as [string, string];
  if (owner === "." || owner === ".." || name === "." || name === "..") {
    throw new Error("Invalid repository identifier.");
  }
  const allowedRaw = config.GITHUB_ALLOWED_REPOS.trim();
  if (allowedRaw) {
    const allowed = allowedRaw.split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
    const lower = trimmed.toLowerCase();
    const ownerPrefix = `${owner.toLowerCase()}/*`;
    if (!allowed.includes(lower) && !allowed.includes(ownerPrefix)) {
      throw new Error(`Repository ${trimmed} is not in GITHUB_ALLOWED_REPOS.`);
    }
  }
  return trimmed;
}

function normalizeRef(ref: string, label: string): string {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.includes("..") || !SAFE_REF_PATTERN.test(trimmed)) {
    throw new Error(`Invalid GitHub ${label}.`);
  }
  return trimmed;
}

function encodePathSegments(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.some(seg => seg === "." || seg === "..")) {
    throw new Error("Invalid repository file path.");
  }
  return segments.map(encodeURIComponent).join("/");
}

export class GitHubClient {
  private readonly baseUrl = config.GITHUB_API_URL.replace(/\/$/, "");

  private headers(tokenOverride?: string): Record<string, string> {
    const token = tokenOverride ?? config.GITHUB_TOKEN;
    if (!token) {
      throw new Error("GitHub token is not configured for this user/project.");
    }
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Friday-Agent/0.1"
    };
  }

  private async request<T>(path: string, init: RequestInit = {}, tokenOverride?: string): Promise<GitHubResponse<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(20000),
      headers: {
        ...this.headers(tokenOverride),
        ...(init.headers ?? {})
      }
    });

    const text = await response.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const message =
        typeof data === "object" && data !== null && "message" in data
          ? String((data as { message: unknown }).message)
          : `GitHub API request failed with HTTP ${response.status}.`;
      throw new Error(message);
    }

    return { data: data as T, headers: response.headers };
  }

  async listRepositories(limit = 20, tokenOverride?: string): Promise<unknown> {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20;
    const result = await this.request<unknown>(`/user/repos?per_page=${safeLimit}&sort=updated`, {}, tokenOverride);
    return result.data;
  }

  async getFile(repo: string, path: string, ref?: string, tokenOverride?: string): Promise<unknown> {
    const safeRepo = normalizeRepo(repo);
    const encodedPath = encodePathSegments(path);
    const safeRef = ref !== undefined ? normalizeRef(ref, "ref") : undefined;
    const query = safeRef ? `?ref=${encodeURIComponent(safeRef)}` : "";
    const result = await this.request<unknown>(`/repos/${safeRepo}/contents/${encodedPath}${query}`, {}, tokenOverride);
    return result.data;
  }

  async searchCode(repo: string, query: string, limit = 20, tokenOverride?: string): Promise<unknown> {
    const safeRepo = normalizeRepo(repo);
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20;
    const cleanedQuery = query.replace(/\b(?:repo|org|user):[^\s]+/gi, "").trim();
    if (!cleanedQuery) {
      throw new Error("Search query must not be empty.");
    }
    const q = encodeURIComponent(`${cleanedQuery} repo:${safeRepo}`);
    const result = await this.request<unknown>(`/search/code?q=${q}&per_page=${safeLimit}`, {}, tokenOverride);
    return result.data;
  }

  private assertMutationAllowed(): void {
    if (!config.FRIDAY_ALLOW_GITHUB_MUTATIONS) {
      throw new Error("GitHub mutations are disabled. Set FRIDAY_ALLOW_GITHUB_MUTATIONS=true only when authorized.");
    }
  }

  async createBranch(repo: string, branch: string, base?: string, tokenOverride?: string): Promise<unknown> {
    this.assertMutationAllowed();
    const safeRepo = normalizeRepo(repo);
    const safeBranch = normalizeRef(branch, "branch");
    const repository = await this.request<{ default_branch: string }>(`/repos/${safeRepo}`, {}, tokenOverride);
    const baseRef = normalizeRef(base ?? repository.data.default_branch, "base");
    const encodedBaseRef = baseRef.split("/").map(encodeURIComponent).join("/");
    const ref = await this.request<{ object: { sha: string } }>(
      `/repos/${safeRepo}/git/ref/heads/${encodedBaseRef}`,
      {},
      tokenOverride
    );
    const result = await this.request<unknown>(`/repos/${safeRepo}/git/refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${safeBranch}`, sha: ref.data.object.sha })
    }, tokenOverride);
    return result.data;
  }

  async upsertFile(
    repo: string,
    path: string,
    content: string,
    branch: string,
    message: string,
    sha?: string,
    tokenOverride?: string
  ): Promise<unknown> {
    this.assertMutationAllowed();
    const safeRepo = normalizeRepo(repo);
    const encodedPath = encodePathSegments(path);
    const safeBranch = normalizeRef(branch, "branch");
    const body: Record<string, unknown> = {
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: safeBranch
    };
    if (sha) body.sha = sha;

    const result = await this.request<unknown>(`/repos/${safeRepo}/contents/${encodedPath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, tokenOverride);
    return result.data;
  }

  async createPullRequest(
    repo: string,
    head: string,
    base: string,
    title: string,
    body?: string,
    tokenOverride?: string
  ): Promise<unknown> {
    this.assertMutationAllowed();
    const safeRepo = normalizeRepo(repo);
    const safeHead = normalizeRef(head, "head");
    const safeBase = normalizeRef(base, "base");
    const result = await this.request<unknown>(`/repos/${safeRepo}/pulls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ head: safeHead, base: safeBase, title, body: body ?? "" })
    }, tokenOverride);
    return result.data;
  }
}
