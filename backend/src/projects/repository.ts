import { pool } from "../db/pool.js";
import type { ToolKey } from "../credentials/service.js";

export type ProjectStatus = "active" | "archived" | "disabled";
export type ProjectRole = "owner" | "admin" | "member" | "viewer";

export type Project = {
  id: string;
  ownerUserId: string;
  name: string;
  description?: string;
  repositoryOwner?: string;
  repositoryName?: string;
  repository?: string;
  repositoryUrl?: string;
  branch: string;
  workspacePath?: string;
  status: ProjectStatus;
  role?: ProjectRole;
  createdAt: string;
  updatedAt: string;
};

export type ProjectToolConfig = {
  id: string;
  projectId: string;
  toolKey: ToolKey;
  enabled: boolean;
  configuration: Record<string, unknown>;
  updatedAt: string;
};

type ProjectRow = {
  id: string;
  owner_user_id: string;
  name: string;
  description: string | null;
  repository_owner: string | null;
  repository_name: string | null;
  repository_url: string | null;
  default_branch: string;
  workspace_path: string | null;
  status: ProjectStatus;
  member_role?: ProjectRole | null;
  created_at: Date;
  updated_at: Date;
};

type ProjectToolRow = {
  id: string;
  project_id: string;
  tool_key: ToolKey;
  enabled: boolean;
  configuration: Record<string, unknown>;
  updated_at: Date;
};

function toProject(row: ProjectRow): Project {
  const repository = row.repository_owner && row.repository_name
    ? `${row.repository_owner}/${row.repository_name}`
    : undefined;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.repository_owner === null ? {} : { repositoryOwner: row.repository_owner }),
    ...(row.repository_name === null ? {} : { repositoryName: row.repository_name }),
    ...(repository ? { repository } : {}),
    ...(row.repository_url === null ? {} : { repositoryUrl: row.repository_url }),
    branch: row.default_branch,
    ...(row.workspace_path === null ? {} : { workspacePath: row.workspace_path }),
    status: row.status,
    ...(row.member_role ? { role: row.member_role } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export class ProjectRepository {
  async list(userId: string, limit = 50): Promise<Project[]> {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 50;
    const { rows } = await pool.query<ProjectRow>(
      `SELECT p.id, p.owner_user_id, p.name, p.description, p.repository_owner,
              p.repository_name, p.repository_url, p.default_branch, p.workspace_path,
              p.status, COALESCE(pm.role, CASE WHEN p.owner_user_id = $1 THEN 'owner' END) AS member_role,
              p.created_at, p.updated_at
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
       WHERE p.owner_user_id = $1 OR pm.user_id = $1
       ORDER BY p.updated_at DESC
       LIMIT $2`,
      [userId, safeLimit]
    );
    return rows.map(toProject);
  }

  async get(userId: string, projectId: string): Promise<Project | undefined> {
    const { rows } = await pool.query<ProjectRow>(
      `SELECT p.id, p.owner_user_id, p.name, p.description, p.repository_owner,
              p.repository_name, p.repository_url, p.default_branch, p.workspace_path,
              p.status, COALESCE(pm.role, CASE WHEN p.owner_user_id = $1 THEN 'owner' END) AS member_role,
              p.created_at, p.updated_at
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
       WHERE p.id = $2 AND (p.owner_user_id = $1 OR pm.user_id = $1)`,
      [userId, projectId]
    );
    return rows[0] ? toProject(rows[0]) : undefined;
  }

  async create(input: {
    ownerUserId: string;
    name: string;
    description?: string;
    repositoryOwner?: string;
    repositoryName?: string;
    repositoryUrl?: string;
    defaultBranch?: string;
    workspacePath?: string;
  }): Promise<Project> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const branch = input.defaultBranch?.trim() || "main";
      const { rows } = await client.query<ProjectRow>(
        `INSERT INTO projects
           (owner_user_id, name, description, repository_owner, repository_name, repository_url, default_branch, workspace_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, owner_user_id, name, description, repository_owner, repository_name,
                   repository_url, default_branch, workspace_path, status, created_at, updated_at`,
        [
          input.ownerUserId,
          input.name.trim(),
          input.description?.trim() ?? null,
          input.repositoryOwner?.trim() ?? null,
          input.repositoryName?.trim() ?? null,
          input.repositoryUrl?.trim() ?? null,
          branch,
          input.workspacePath?.trim() ?? null
        ]
      );
      const project = rows[0]!;
      await client.query(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT (project_id, user_id) DO NOTHING`,
        [project.id, input.ownerUserId]
      );
      await client.query(
        `INSERT INTO project_settings (project_id, default_branch)
         VALUES ($1, $2)
         ON CONFLICT (project_id) DO NOTHING`,
        [project.id, branch]
      );
      await client.query("COMMIT");
      return toProject({ ...project, member_role: "owner" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listTools(userId: string, projectId: string): Promise<ProjectToolConfig[] | undefined> {
    const project = await this.get(userId, projectId);
    if (!project) return undefined;
    const { rows } = await pool.query<ProjectToolRow>(
      `SELECT id, project_id, tool_key, enabled, configuration, updated_at
       FROM project_tools
       WHERE project_id = $1
       ORDER BY tool_key ASC`,
      [projectId]
    );
    return rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      toolKey: row.tool_key,
      enabled: row.enabled,
      configuration: row.configuration ?? {},
      updatedAt: row.updated_at.toISOString()
    }));
  }

  async upsertTool(
    userId: string,
    projectId: string,
    toolKey: ToolKey,
    enabled: boolean,
    configuration: Record<string, unknown> = {}
  ): Promise<ProjectToolConfig | undefined> {
    const project = await this.get(userId, projectId);
    if (!project) return undefined;
    if (project.role !== "owner" && project.role !== "admin") {
      throw new Error("Only project owners or admins can update project tools.");
    }
    const { rows } = await pool.query<ProjectToolRow>(
      `INSERT INTO project_tools (project_id, tool_key, enabled, configuration)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (project_id, tool_key) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             configuration = EXCLUDED.configuration,
             updated_at = NOW()
       RETURNING id, project_id, tool_key, enabled, configuration, updated_at`,
      [projectId, toolKey, enabled, JSON.stringify(configuration)]
    );
    const row = rows[0]!;
    return {
      id: row.id,
      projectId: row.project_id,
      toolKey: row.tool_key,
      enabled: row.enabled,
      configuration: row.configuration ?? {},
      updatedAt: row.updated_at.toISOString()
    };
  }

  async isToolEnabled(projectId: string, toolKey: ToolKey): Promise<boolean | undefined> {
    const { rows } = await pool.query<{ enabled: boolean }>(
      "SELECT enabled FROM project_tools WHERE project_id = $1 AND tool_key = $2",
      [projectId, toolKey]
    );
    return rows[0]?.enabled;
  }
}
