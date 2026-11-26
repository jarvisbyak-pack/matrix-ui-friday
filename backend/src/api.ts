import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { z } from "zod";
import { AuthPolicyError, AuthService, type AuthenticatedUser } from "./auth/service.js";
import { requireAuth, type AuthenticatedRequest } from "./auth/middleware.js";
import { AiService } from "./ai/service.js";
import { AgentService } from "./agent/service.js";
import { AgentRunRepository } from "./agent/runs-repository.js";
import { ConversationRepository } from "./conversations/repository.js";
import { CredentialService, TOOL_KEYS } from "./credentials/service.js";
import { FileService } from "./files/service.js";
import { ProjectRepository } from "./projects/repository.js";
import { UserSettingsRepository } from "./settings/repository.js";
import { TaskEventRepository } from "./tasks/task-events.js";
import { PostgresTaskRepository } from "./tasks/task-repository.js";
import { TaskService } from "./tasks/task-service.js";
import { config } from "./config.js";
import { createDefaultToolRegistry } from "./tools/index.js";
import { checkDatabase } from "./db/pool.js";
import { OAuthService, type OAuthProvider } from "./auth/oauth.js";
import { googleAuthorizationUrl, exchangeGoogleCode } from "./auth/providers/google.js";
import { githubAuthorizationUrl, exchangeGithubCode } from "./auth/providers/github.js";

const uuidSchema = z.string().uuid();

const chatMessagesSchema = z.array(
  z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1)
  })
).min(1);

const agentInputSchema = z.object({
  messages: chatMessagesSchema,
  model: z.string().trim().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxSteps: z.number().int().min(1).max(20).optional(),
  projectId: z.string().uuid().optional()
});

const taskRequestSchema = z.object({
  type: z.string().trim().min(1).max(200),
  input: z.unknown().optional()
});

const chatRequestSchema = z.object({
  messages: chatMessagesSchema,
  model: z.string().trim().min(1).optional(),
  temperature: z.number().min(0).max(2).optional()
});

const conversationCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional()
});

const storedMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(100000),
  metadata: z.unknown().optional()
});

const fileUploadSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(255).default("application/octet-stream"),
  contentBase64: z.string().min(1)
});

const memorySchema = z.object({
  content: z.string().trim().min(1).max(10000),
  kind: z.string().trim().min(1).max(100).optional(),
  conversationId: z.string().uuid().optional(),
  metadata: z.unknown().optional()
});

const authRegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200)
});

const authLoginSchema = authRegisterSchema;

const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  repositoryOwner: z.string().trim().regex(/^[A-Za-z0-9_.-]+$/).max(100).optional(),
  repositoryName: z.string().trim().regex(/^[A-Za-z0-9_.-]+$/).max(100).optional(),
  repositoryUrl: z.string().url().max(500).optional(),
  defaultBranch: z.string().trim().min(1).max(120).optional(),
  workspacePath: z.string().trim().max(500).optional()
});

const projectToolUpdateSchema = z.object({
  enabled: z.boolean(),
  configuration: z.record(z.string(), z.unknown()).optional()
});

const userSettingsSchema = z.object({
  accentColor: z.enum(["blue", "purple", "red", "green", "custom"]).optional(),
  accentCustomValue: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  theme: z.enum(["dark", "light", "system"]).optional()
});

const credentialSaveSchema = z.object({
  projectId: z.string().uuid().optional(),
  toolKey: z.enum(TOOL_KEYS),
  credentialType: z.string().trim().min(1).max(64).default("token"),
  secret: z.string().trim().min(1).max(4096),
  enabled: z.boolean().optional()
});

function getAuthenticatedUserId(req: Request): string {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  if (!userId) throw new Error("Authenticated user context is missing.");
  return userId;
}

function getAuthenticatedUser(req: Request): AuthenticatedUser {
  const user = (req as unknown as AuthenticatedRequest).user;
  if (!user) throw new Error("Authenticated user context is missing.");
  return user;
}

function bearerToken(req: Request): string {
  const header = req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function parseUuid(value: string | undefined): string | undefined {
  const result = uuidSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function createRateLimiter(windowMs: number, maxRequests: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const authUser = (req as unknown as Partial<AuthenticatedRequest>).userId;
    const key = authUser ? `user:${authUser}` : `ip:${req.ip || "unknown"}`;
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      if (buckets.size > 5000) {
        for (const [k, entry] of buckets) {
          if (entry.resetAt <= now) buckets.delete(k);
        }
      }
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (existing.count >= maxRequests) {
      const retrySeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retrySeconds));
      res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." } });
      return;
    }

    existing.count += 1;
    next();
  };
}

export type FridayApiApp = ReturnType<typeof express> & {
  locals: Record<string, unknown> & {
    closeActiveStreams?: () => void;
  };
};

export function createApi(): FridayApiApp {
  const app = express() as FridayApiApp;
  const auth = new AuthService();
  const oauth = new OAuthService(auth);
  const requireAuthentication = requireAuth(auth);
  const taskService = new TaskService(new PostgresTaskRepository());
  const aiService = new AiService();
  const agentService = new AgentService();
  const agentRuns = new AgentRunRepository();
  const conversations = new ConversationRepository();
  const credentials = new CredentialService();
  const files = new FileService();
  const projects = new ProjectRepository();
  const settings = new UserSettingsRepository();
  const events = new TaskEventRepository();
  const activeStreams = new Set<Response>();

  app.locals.closeActiveStreams = () => {
    for (const stream of activeStreams) {
      try {
        stream.end();
      } catch {
        // Ignore already-closed streams.
      }
    }
    activeStreams.clear();
  };

  app.disable("x-powered-by");
  if (config.TRUST_PROXY) {
    app.set("trust proxy", 1);
  }

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  const allowedOrigins = new Set(
    config.FRONTEND_ORIGIN.split(",").map(origin => origin.trim()).filter(Boolean)
  );

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, false);
        return;
      }
      callback(null, allowedOrigins.has(origin) ? origin : false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204
  }));

  const maxUploadJsonBytes = Math.ceil(config.FILE_MAX_BYTES * 1.45) + 1024 * 1024;
  const uploadJsonParser = express.json({ limit: maxUploadJsonBytes });
  const defaultJsonParser = express.json({ limit: "2mb" });

  app.use((req, res, next) => {
    if (req.path === "/api/files" && req.method === "POST") {
      uploadJsonParser(req, res, next);
      return;
    }
    defaultJsonParser(req, res, next);
  });

  const authRateLimiter = createRateLimiter(60_000, 60);
  const aiRateLimiter = createRateLimiter(60_000, 60);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "friday-backend", timestamp: new Date().toISOString() });
  });

  app.get("/api/ready", async (_req, res) => {
    try {
      await checkDatabase();
      res.json({ ok: true, ready: true, database: "ok" });
    } catch {
      res.status(503).json({ ok: false, ready: false, database: "unavailable" });
    }
  });

  app.post("/api/auth/register", authRateLimiter, async (req, res) => {
    const parsed = authRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid registration request.", details: parsed.error.flatten() } });
      return;
    }
    try {
      const user = await auth.register(parsed.data.email, parsed.data.password);
      res.status(201).json({ user });
    } catch (error) {
      if (error instanceof AuthPolicyError) {
        res.status(403).json({ error: { code: "REGISTRATION_RESTRICTED", message: error.message } });
        return;
      }
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "23505") {
        res.status(409).json({ error: { code: "EMAIL_EXISTS", message: "An account with that email already exists." } });
        return;
      }
      console.error("Registration failed:", error);
      res.status(503).json({ error: { code: "AUTH_UNAVAILABLE", message: "Authentication service unavailable." } });
    }
  });

  app.post("/api/auth/login", authRateLimiter, async (req, res) => {
    const parsed = authLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid login request.", details: parsed.error.flatten() } });
      return;
    }
    try {
      const result = await auth.login(parsed.data.email, parsed.data.password);
      res.json(result);
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid email or password.") {
        res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: error.message } });
        return;
      }
      console.error("Login failed:", error);
      res.status(503).json({ error: { code: "AUTH_UNAVAILABLE", message: "Authentication service unavailable." } });
    }
  });

  app.get("/api/auth/:provider/start", authRateLimiter, async (req, res) => {
    const provider = req.params.provider as OAuthProvider;
    if (provider !== "google" && provider !== "github") {
      res.status(404).json({ error: { code: "OAUTH_PROVIDER_NOT_FOUND", message: "OAuth provider not found." } });
      return;
    }
    if (!oauth.isConfigured(provider)) {
      res.status(503).json({ error: { code: "OAUTH_NOT_CONFIGURED", message: provider + " sign-in is not configured on this backend." } });
      return;
    }

    let frontendRedirectUri: string | undefined;
    if (typeof req.query.redirect_to === "string" && req.query.redirect_to.trim()) {
      try {
        const candidate = new URL(req.query.redirect_to.trim());
        if (allowedOrigins.has(candidate.origin)) {
          frontendRedirectUri = `${candidate.origin}${candidate.pathname}`.replace(/\/$/, "");
        }
      } catch {
        // Ignore malformed redirect_to and fall back to configured OAUTH_FRONTEND_ORIGIN.
      }
    }

    try {
      const state = await oauth.createState(provider, frontendRedirectUri);
      const url = provider === "google" ? googleAuthorizationUrl(state) : githubAuthorizationUrl(state);
      res.redirect(url);
    } catch (error) {
      console.error("OAuth start failed:", error);
      res.status(503).json({ error: { code: "OAUTH_UNAVAILABLE", message: "OAuth service unavailable." } });
    }
  });

  app.get("/api/auth/:provider/callback", authRateLimiter, async (req, res) => {
    const provider = req.params.provider as OAuthProvider;
    if (provider !== "google" && provider !== "github") {
      res.status(404).send("OAuth provider not found.");
      return;
    }
    const defaultFrontend = config.OAUTH_FRONTEND_ORIGIN.replace(/\/$/, "");
    let frontend = defaultFrontend;
    const fail = (message: string) => res.redirect(frontend + "/?oauth_error=" + encodeURIComponent(message));
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !state) { fail("OAuth callback was missing required parameters."); return; }
    try {
      const stateRedirect = await oauth.consumeState(provider, state);
      if (stateRedirect) {
        try {
          const parsedRedirect = new URL(stateRedirect);
          if (allowedOrigins.has(parsedRedirect.origin) || parsedRedirect.origin === new URL(defaultFrontend).origin) {
            frontend = stateRedirect.replace(/\/$/, "");
          }
        } catch {
          frontend = defaultFrontend;
        }
      }
      const identity = provider === "google" ? await exchangeGoogleCode(code) : await exchangeGithubCode(code);
      const userId = await oauth.signInWithIdentity(provider, identity.subject, identity.email);
      const exchangeCode = await oauth.createExchangeCode(userId);
      res.redirect(frontend + "/?oauth_code=" + encodeURIComponent(exchangeCode));
    } catch (error) {
      console.error("OAuth callback failed:", error);
      fail(error instanceof Error ? error.message : "OAuth sign-in failed.");
    }
  });

  app.post("/api/auth/oauth/exchange", authRateLimiter, async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    if (!code) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "OAuth exchange code is required." } });
      return;
    }
    try {
      res.json(await oauth.exchangeCode(code));
    } catch (error) {
      res.status(401).json({ error: { code: "INVALID_OAUTH_CODE", message: error instanceof Error ? error.message : "Invalid OAuth code." } });
    }
  });

  app.get("/api/auth/me", requireAuthentication, (req, res) => {
    res.json({ user: getAuthenticatedUser(req) });
  });

  app.post("/api/auth/logout", requireAuthentication, async (req, res) => {
    try {
      await auth.revoke(bearerToken(req));
      res.status(204).send();
    } catch {
      res.status(503).json({ error: { code: "AUTH_UNAVAILABLE", message: "Authentication service unavailable." } });
    }
  });

  app.use("/api/conversations", requireAuthentication);
  app.use("/api/memories", requireAuthentication);
  app.use("/api/files", requireAuthentication);
  app.use("/api/chat", requireAuthentication);
  app.use("/api/agent", requireAuthentication);
  app.use("/api/agent-runs", requireAuthentication);
  app.use("/api/tasks", requireAuthentication);
  app.use("/api/projects", requireAuthentication);
  app.use("/api/settings", requireAuthentication);
  app.use("/api/credentials", requireAuthentication);

  app.post("/api/conversations", async (req: Request, res: Response) => {
    const parsed = conversationCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid conversation request.", details: parsed.error.flatten() } });
      return;
    }
    try {
      const userId = getAuthenticatedUserId(req);
      const conversation = await conversations.create(parsed.data.title, userId);
      res.status(201).json({ conversation });
    } catch (error) {
      console.error("Conversation creation failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Conversation service unavailable." } });
    }
  });

  app.get("/api/conversations", async (req, res) => {
    try {
      res.json({ conversations: await conversations.list(getAuthenticatedUserId(req)) });
    } catch (error) {
      console.error("Conversation listing failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Conversation service unavailable." } });
    }
  });

  app.get("/api/conversations/:id", async (req, res) => {
    const id = parseUuid(req.params.id);
    if (!id) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid conversation ID." } });
      return;
    }
    try {
      const conversation = await conversations.get(id, getAuthenticatedUserId(req));
      if (!conversation) {
        res.status(404).json({ error: { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found." } });
        return;
      }
      res.json({ conversation });
    } catch (error) {
      console.error("Conversation lookup failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Conversation service unavailable." } });
    }
  });

  app.delete("/api/conversations/:id", async (req, res) => {
    const id = parseUuid(req.params.id);
    if (!id) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid conversation ID." } });
      return;
    }
    try {
      const removed = await conversations.remove(id, getAuthenticatedUserId(req));
      if (!removed) {
        res.status(404).json({ error: { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found." } });
        return;
      }
      res.status(204).send();
    } catch (error) {
      console.error("Conversation deletion failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Conversation service unavailable." } });
    }
  });

  app.get("/api/conversations/:id/messages", async (req, res) => {
    const id = parseUuid(req.params.id);
    if (!id) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid conversation ID." } });
      return;
    }
    try {
      const userId = getAuthenticatedUserId(req);
      const conversation = await conversations.get(id, userId);
      if (!conversation) {
        res.status(404).json({ error: { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found." } });
        return;
      }
      res.json({ messages: await conversations.listMessages(id) });
    } catch (error) {
      console.error("Message listing failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Conversation service unavailable." } });
    }
  });

  app.post("/api/conversations/:id/messages", async (req, res) => {
    const id = parseUuid(req.params.id);
    if (!id) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid conversation ID." } });
      return;
    }
    const parsed = storedMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid message request.", details: parsed.error.flatten() } });
      return;
    }
    try {
      const userId = getAuthenticatedUserId(req);
      const conversation = await conversations.get(id, userId);
      if (!conversation) {
        res.status(404).json({ error: { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found." } });
        return;
      }
      const message = await conversations.addMessage(id, parsed.data.role, parsed.data.content, parsed.data.metadata);
      res.status(201).json({ message });
    } catch (error) {
      console.error("Message creation failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Conversation service unavailable." } });
    }
  });

  app.get("/api/files", async (req, res) => {
    try {
      const userId = getAuthenticatedUserId(req);
      res.json({ files: await files.list(userId) });
    } catch (error) {
      console.error("File listing failed:", error);
      res.status(503).json({ error: { code: "FILE_STORE_UNAVAILABLE", message: "File service unavailable." } });
    }
  });

  app.post("/api/files", async (req, res) => {
    const parsed = fileUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid file upload request.", details: parsed.error.flatten() } });
      return;
    }
    const normalizedBase64 = parsed.data.contentBase64.replace(/\s+/g, "");
    if (!normalizedBase64 || normalizedBase64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalizedBase64)) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "contentBase64 must be valid base64 data." } });
      return;
    }
    try {
      const userId = getAuthenticatedUserId(req);
      const content = Buffer.from(normalizedBase64, "base64");
      const file = await files.save(userId, parsed.data.name, parsed.data.mimeType, content);
      res.status(201).json({ file });
    } catch (error) {
      const message = error instanceof Error ? error.message : "File upload failed.";
      if (message.includes("exceeds the")) {
        res.status(413).json({ error: { code: "FILE_TOO_LARGE", message } });
        return;
      }
      console.error("File upload failed:", error);
      res.status(503).json({ error: { code: "FILE_STORE_UNAVAILABLE", message: "File service unavailable." } });
    }
  });

  app.get("/api/files/:id", async (req, res) => {
    const id = parseUuid(req.params.id);
    if (!id) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid file ID." } });
      return;
    }
    try {
      const result = await files.read(getAuthenticatedUserId(req), id);
      if (!result) {
        res.status(404).json({ error: { code: "FILE_NOT_FOUND", message: "File not found." } });
        return;
      }
      const safeName = result.file.name.replace(/["\\\r\n]/g, "") || "download";
      res.setHeader("Content-Type", result.file.mimeType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.send(result.content);
    } catch (error) {
      console.error("File read failed:", error);
      res.status(503).json({ error: { code: "FILE_STORE_UNAVAILABLE", message: "File service unavailable." } });
    }
  });

  app.post("/api/memories", async (req, res) => {
    const parsed = memorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid memory request.", details: parsed.error.flatten() } });
      return;
    }
    try {
      const userId = getAuthenticatedUserId(req);
      if (parsed.data.conversationId) {
        const conversation = await conversations.get(parsed.data.conversationId, userId);
        if (!conversation) {
          res.status(404).json({ error: { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found." } });
          return;
        }
      }
      const memory = await conversations.addMemory({ ...parsed.data, userId });
      res.status(201).json({ memory });
    } catch (error) {
      console.error("Memory creation failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Memory service unavailable." } });
    }
  });

  app.get("/api/memories", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!query) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Query parameter q is required." } });
      return;
    }
    try {
      res.json({ memories: await conversations.searchMemories(query, getAuthenticatedUserId(req)) });
    } catch (error) {
      console.error("Memory search failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Memory service unavailable." } });
    }
  });

  app.post("/api/chat", aiRateLimiter, async (req: Request, res: Response) => {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid chat request.", details: parsed.error.flatten() } });
      return;
    }
    try {
      const result = await aiService.generate(parsed.data);
      res.json({ result });
    } catch (error) {
      console.error("AI generation failed:", error);
      res.status(502).json({ error: { code: "AI_PROVIDER_ERROR", message: "AI provider request failed." } });
    }
  });

  app.post("/api/agent", aiRateLimiter, async (req: Request, res: Response) => {
    const parsed = agentInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid agent request.", details: parsed.error.flatten() } });
      return;
    }
    const user = getAuthenticatedUser(req);
    let runId: string | undefined;
    try {
      if (parsed.data.projectId) {
        const project = await projects.get(user.id, parsed.data.projectId);
        if (!project) {
          res.status(404).json({ error: { code: "PROJECT_NOT_FOUND", message: "Project not found." } });
          return;
        }
      }
      const run = await agentRuns.create({
        userId: user.id,
        projectId: parsed.data.projectId,
        status: "running",
        input: parsed.data
      });
      runId = run.id;

      const result = await agentService.run({
        ...parsed.data,
        userId: user.id,
        userEmail: user.email,
        agentRunId: runId
      });
      await agentRuns.complete(runId, result);
      res.json({ result, agentRunId: runId });
    } catch (error) {
      console.error("Agent execution failed:", error);
      if (runId) {
        const message = error instanceof Error ? error.message : "Agent execution failed.";
        await agentRuns.fail(runId, { message }).catch(() => {});
      }
      res.status(502).json({ error: { code: "AGENT_EXECUTION_ERROR", message: "Agent execution failed." } });
    }
  });

  app.get("/api/agent-runs", async (req, res) => {
    try {
      const list = await agentRuns.list(getAuthenticatedUserId(req));
      res.json({ runs: list });
    } catch (error) {
      console.error("Agent runs listing failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Agent run service unavailable." } });
    }
  });

  app.get("/api/agent-runs/:id", async (req, res) => {
    const id = parseUuid(req.params.id);
    if (!id) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid agent run ID." } });
      return;
    }
    try {
      const run = await agentRuns.get(getAuthenticatedUserId(req), id);
      if (!run) {
        res.status(404).json({ error: { code: "AGENT_RUN_NOT_FOUND", message: "Agent run not found." } });
        return;
      }
      res.json({ run });
    } catch (error) {
      console.error("Agent run lookup failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Agent run service unavailable." } });
    }
  });

  app.get("/api/agent-runs/:id/logs", async (req, res) => {
    const id = parseUuid(req.params.id);
    if (!id) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid agent run ID." } });
      return;
    }
    const after = req.query.after === undefined ? 0 : Number(req.query.after);
    if (!Number.isInteger(after) || after < 0) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid after cursor." } });
      return;
    }
    try {
      const logs = await agentRuns.listLogs(getAuthenticatedUserId(req), id, after);
      if (!logs) {
        res.status(404).json({ error: { code: "AGENT_RUN_NOT_FOUND", message: "Agent run not found." } });
        return;
      }
      res.json({ logs });
    } catch (error) {
      console.error("Execution logs lookup failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Agent run service unavailable." } });
    }
  });

  app.post("/api/tasks", aiRateLimiter, async (req: Request, res: Response) => {
    const parsed = taskRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid task request.", details: parsed.error.flatten() } });
      return;
    }

    const userId = getAuthenticatedUserId(req);
    let taskInput = parsed.data.input;
    if (parsed.data.type === "agent") {
      const agentParsed = agentInputSchema.safeParse(parsed.data.input);
      if (!agentParsed.success) {
        res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid agent task input.", details: agentParsed.error.flatten() } });
        return;
      }
      if (agentParsed.data.projectId) {
        const project = await projects.get(userId, agentParsed.data.projectId).catch(() => undefined);
        if (!project) {
          res.status(404).json({ error: { code: "PROJECT_NOT_FOUND", message: "Project not found." } });
          return;
        }
      }
      taskInput = agentParsed.data;
    }

    try {
      const task = await taskService.create(parsed.data.type, taskInput, userId);
      await events.append(task.id, "task.queued", { type: task.type });
      res.status(202).json({ task });
    } catch (error) {
      console.error("Task creation failed:", error);
      res.status(503).json({ error: { code: "TASK_STORE_UNAVAILABLE", message: "Task service unavailable." } });
    }
  });

  app.get("/api/tasks", async (req, res) => {
    try {
      const tasks = await taskService.list(getAuthenticatedUserId(req));
      res.json({ tasks });
    } catch (error) {
      console.error("Task listing failed:", error);
      res.status(503).json({ error: { code: "TASK_STORE_UNAVAILABLE", message: "Task service unavailable." } });
    }
  });

  app.post("/api/tasks/:id/cancel", async (req, res) => {
    const id = parseUuid(req.params.id);
    if (!id) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid task ID." } });
      return;
    }
    try {
      const task = await taskService.cancel(id, getAuthenticatedUserId(req));
      if (!task) {
        res.status(404).json({ error: { code: "TASK_NOT_FOUND", message: "Task not found." } });
        return;
      }
      await events.append(task.id, "task.cancel_requested", { state: task.state });
      res.json({ task });
    } catch (error) {
      console.error("Task cancel failed:", error);
      res.status(503).json({ error: { code: "TASK_STORE_UNAVAILABLE", message: "Task service unavailable." } });
    }
  });

  app.get("/api/tasks/:id/events", async (req, res) => {
    const id = parseUuid(req.params.id);
    if (!id) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid task ID." } });
      return;
    }
    const rawAfter = req.query.after === undefined ? 0 : Number(req.query.after);
    if (!Number.isInteger(rawAfter) || rawAfter < 0) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Query parameter after must be a non-negative integer." } });
      return;
    }

    const userId = getAuthenticatedUserId(req);
    let task;
    try {
      task = await taskService.get(id, userId);
    } catch (error) {
      console.error("Task event lookup failed:", error);
      res.status(503).json({ error: { code: "TASK_STORE_UNAVAILABLE", message: "Task service unavailable." } });
      return;
    }

    if (!task) {
      res.status(404).json({ error: { code: "TASK_NOT_FOUND", message: "Task not found." } });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    activeStreams.add(res);

    let sequence = rawAfter;
    let closed = false;
    let timer: NodeJS.Timeout | undefined;

    const closeStream = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      activeStreams.delete(res);
      if (!res.writableEnded) {
        res.end();
      }
    };

    const writeEvents = async (): Promise<void> => {
      if (closed) return;
      try {
        const next = await events.listAfter(id, sequence);
        for (const event of next) {
          sequence = event.sequence;
          res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
        }

        const latestTask = await taskService.get(id, userId);
        if (!latestTask || latestTask.state === "completed" || latestTask.state === "failed") {
          const tail = await events.listAfter(id, sequence);
          for (const event of tail) {
            sequence = event.sequence;
            res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
          }
          closeStream();
          return;
        }
      } catch (error) {
        console.error("Task event stream failed:", error);
        if (!res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify({ message: "Event stream failed." })}\n\n`);
        }
      }
      if (!closed) {
        timer = setTimeout(() => void writeEvents(), 500);
      }
    };

    req.on("close", closeStream);
    res.on("close", closeStream);

    void writeEvents();
  });

  app.get("/api/tasks/:id", async (req, res) => {
    const id = parseUuid(req.params.id);
    if (!id) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid task ID." } });
      return;
    }
    try {
      const task = await taskService.get(id, getAuthenticatedUserId(req));
      if (!task) {
        res.status(404).json({ error: { code: "TASK_NOT_FOUND", message: "Task not found." } });
        return;
      }
      res.json({ task });
    } catch (error) {
      console.error("Task lookup failed:", error);
      res.status(503).json({ error: { code: "TASK_STORE_UNAVAILABLE", message: "Task service unavailable." } });
    }
  });

  app.get("/api/tools", requireAuthentication, (_req, res) => {
    const registry = createDefaultToolRegistry();
    res.json({ tools: registry.list().map(tool => tool.definition) });
  });

  app.get("/api/projects", async (req, res) => {
    try {
      const list = await projects.list(getAuthenticatedUserId(req));
      res.json({ projects: list });
    } catch (error) {
      console.error("Project listing failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Project service unavailable." } });
    }
  });

  app.post("/api/projects", async (req, res) => {
    const parsed = projectCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid project request.", details: parsed.error.flatten() } });
      return;
    }
    try {
      const project = await projects.create({
        ...parsed.data,
        ownerUserId: getAuthenticatedUserId(req)
      });
      res.status(201).json({ project });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "23505") {
        res.status(409).json({ error: { code: "PROJECT_EXISTS", message: "A project for that repository already exists." } });
        return;
      }
      console.error("Project creation failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Project service unavailable." } });
    }
  });

  app.get("/api/projects/:id/tools", async (req, res) => {
    const id = parseUuid(req.params.id);
    if (!id) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid project ID." } });
      return;
    }
    try {
      const tools = await projects.listTools(getAuthenticatedUserId(req), id);
      if (!tools) {
        res.status(404).json({ error: { code: "PROJECT_NOT_FOUND", message: "Project not found." } });
        return;
      }
      res.json({ tools });
    } catch (error) {
      console.error("Project tools lookup failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Project service unavailable." } });
    }
  });

  app.put("/api/projects/:id/tools/:toolKey", async (req, res) => {
    const id = parseUuid(req.params.id);
    const toolKey = z.enum(TOOL_KEYS).safeParse(req.params.toolKey);
    if (!id || !toolKey.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid project ID or tool key." } });
      return;
    }
    const parsed = projectToolUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid tool update request.", details: parsed.error.flatten() } });
      return;
    }
    try {
      const updated = await projects.upsertTool(
        getAuthenticatedUserId(req),
        id,
        toolKey.data,
        parsed.data.enabled,
        parsed.data.configuration ?? {}
      );
      if (!updated) {
        res.status(404).json({ error: { code: "PROJECT_NOT_FOUND", message: "Project not found." } });
        return;
      }
      res.json({ tool: updated });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Only project owners")) {
        res.status(403).json({ error: { code: "FORBIDDEN", message: error.message } });
        return;
      }
      console.error("Project tool update failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Project service unavailable." } });
    }
  });

  app.get("/api/settings", async (req, res) => {
    try {
      const userSettings = await settings.get(getAuthenticatedUserId(req));
      res.json({ settings: userSettings });
    } catch (error) {
      console.error("User settings lookup failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Settings service unavailable." } });
    }
  });

  app.put("/api/settings", async (req, res) => {
    const parsed = userSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid settings request.", details: parsed.error.flatten() } });
      return;
    }
    try {
      const updated = await settings.upsert(getAuthenticatedUserId(req), parsed.data);
      res.json({ settings: updated });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Custom accent color")) {
        res.status(400).json({ error: { code: "INVALID_REQUEST", message: error.message } });
        return;
      }
      console.error("User settings update failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Settings service unavailable." } });
    }
  });

  app.get("/api/credentials", async (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? parseUuid(req.query.projectId) : undefined;
    if (req.query.projectId !== undefined && !projectId) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid projectId parameter." } });
      return;
    }
    try {
      const list = await credentials.list(getAuthenticatedUserId(req), projectId);
      res.json({ credentials: list });
    } catch (error) {
      console.error("Credentials listing failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Credential service unavailable." } });
    }
  });

  app.post("/api/credentials", async (req, res) => {
    const parsed = credentialSaveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid credential request.", details: parsed.error.flatten() } });
      return;
    }
    const userId = getAuthenticatedUserId(req);
    try {
      if (parsed.data.projectId) {
        const project = await projects.get(userId, parsed.data.projectId);
        if (!project) {
          res.status(404).json({ error: { code: "PROJECT_NOT_FOUND", message: "Project not found." } });
          return;
        }
      }
      const saved = await credentials.save({
        userId,
        projectId: parsed.data.projectId,
        toolKey: parsed.data.toolKey,
        credentialType: parsed.data.credentialType,
        secret: parsed.data.secret,
        enabled: parsed.data.enabled
      });
      res.status(201).json({ credential: saved });
    } catch (error) {
      if (error instanceof Error && error.message.includes("TOOL_ENCRYPTION_KEY")) {
        res.status(503).json({ error: { code: "CREDENTIALS_UNAVAILABLE", message: error.message } });
        return;
      }
      console.error("Credential save failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Credential service unavailable." } });
    }
  });

  app.delete("/api/credentials/:id", async (req, res) => {
    const id = parseUuid(req.params.id);
    if (!id) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid credential ID." } });
      return;
    }
    try {
      const removed = await credentials.remove(getAuthenticatedUserId(req), id);
      if (!removed) {
        res.status(404).json({ error: { code: "CREDENTIAL_NOT_FOUND", message: "Credential not found." } });
        return;
      }
      res.status(204).send();
    } catch (error) {
      console.error("Credential delete failed:", error);
      res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Credential service unavailable." } });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError && "body" in error) {
      res.status(400).json({ error: { code: "INVALID_JSON", message: "Malformed JSON request body." } });
      return;
    }
    if (error && typeof error === "object" && "type" in error && (error as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the maximum size limit." } });
      return;
    }
    console.error("Unhandled API error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error." } });
    }
  });

  return app;
}
