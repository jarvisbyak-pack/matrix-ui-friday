import { config, parseEmailSet } from "../config.js";
import { CredentialService } from "../credentials/service.js";
import { pool } from "../db/pool.js";
import { GitHubClient } from "../github/client.js";
import type { Tool, ToolExecutionContext } from "./types.js";

const client = new GitHubClient();
const credentials = new CredentialService();

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Tool input must be an object.");
  }
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

export async function resolveGitHubTokenForContext(context: ToolExecutionContext): Promise<string | undefined> {
  if (context.userId) {
    const userSecret = await credentials.resolveSecret(context.userId, "github", context.projectId);
    if (userSecret) return userSecret;
  }

  if (config.GITHUB_TOKEN) {
    if (config.GITHUB_ALLOW_SHARED_TOKEN) {
      return config.GITHUB_TOKEN;
    }
    const owners = parseEmailSet(config.OWNER_EMAILS);
    if (owners.size > 0) {
      let email = context.userEmail?.trim().toLowerCase();
      if (!email && context.userId) {
        const { rows } = await pool.query<{ email: string }>(
          "SELECT email FROM users WHERE id = $1",
          [context.userId]
        );
        email = rows[0]?.email?.trim().toLowerCase();
      }
      if (email && owners.has(email)) {
        return config.GITHUB_TOKEN;
      }
    }
    throw new Error("GitHub access requires a user or project GitHub credential (shared server GITHUB_TOKEN is disabled for non-owner accounts).");
  }

  throw new Error("GitHub token is not configured for this user or deployment.");
}

export const githubListRepositoriesTool: Tool = {
  definition: {
    name: "github.list_repositories",
    description: "List repositories accessible to the configured GitHub account.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const value = objectInput(input);
    const token = await resolveGitHubTokenForContext(context);
    return client.listRepositories(typeof value.limit === "number" ? value.limit : 20, token);
  }
};

export const githubGetFileTool: Tool = {
  definition: {
    name: "github.get_file",
    description: "Read a file or directory from a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string" },
        ref: { type: "string" }
      },
      required: ["repo", "path"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const value = objectInput(input);
    const token = await resolveGitHubTokenForContext(context);
    return client.getFile(
      requiredString(value, "repo"),
      requiredString(value, "path"),
      typeof value.ref === "string" ? value.ref : undefined,
      token
    );
  }
};

export const githubSearchCodeTool: Tool = {
  definition: {
    name: "github.search_code",
    description: "Search indexed code in a specific GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      },
      required: ["repo", "query"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const value = objectInput(input);
    const token = await resolveGitHubTokenForContext(context);
    return client.searchCode(
      requiredString(value, "repo"),
      requiredString(value, "query"),
      typeof value.limit === "number" ? value.limit : 20,
      token
    );
  }
};

export const githubCreateBranchTool: Tool = {
  definition: {
    name: "github.create_branch",
    description: "Create a GitHub branch. This is a mutation and requires explicit mutation enablement.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, branch: { type: "string" }, base: { type: "string" } },
      required: ["repo", "branch"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const value = objectInput(input);
    const token = await resolveGitHubTokenForContext(context);
    return client.createBranch(
      requiredString(value, "repo"),
      requiredString(value, "branch"),
      typeof value.base === "string" ? value.base : undefined,
      token
    );
  }
};

export const githubUpsertFileTool: Tool = {
  definition: {
    name: "github.upsert_file",
    description: "Create or update a text file in a GitHub branch. Mutation is disabled unless explicitly enabled.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        branch: { type: "string" },
        message: { type: "string" },
        sha: { type: "string" }
      },
      required: ["repo", "path", "content", "branch", "message"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const value = objectInput(input);
    const token = await resolveGitHubTokenForContext(context);
    return client.upsertFile(
      requiredString(value, "repo"),
      requiredString(value, "path"),
      requiredString(value, "content"),
      requiredString(value, "branch"),
      requiredString(value, "message"),
      typeof value.sha === "string" ? value.sha : undefined,
      token
    );
  }
};

export const githubCreatePullRequestTool: Tool = {
  definition: {
    name: "github.create_pull_request",
    description: "Create a GitHub pull request. Mutation is disabled unless explicitly enabled.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        head: { type: "string" },
        base: { type: "string" },
        title: { type: "string" },
        body: { type: "string" }
      },
      required: ["repo", "head", "base", "title"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const value = objectInput(input);
    const token = await resolveGitHubTokenForContext(context);
    return client.createPullRequest(
      requiredString(value, "repo"),
      requiredString(value, "head"),
      requiredString(value, "base"),
      requiredString(value, "title"),
      typeof value.body === "string" ? value.body : undefined,
      token
    );
  }
};
