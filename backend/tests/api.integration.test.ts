import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import { createApi } from "../src/api.js";
import { migrate } from "../src/db/migrate.js";
import { pool } from "../src/db/pool.js";
import { PostgresTaskRepository } from "../src/tasks/task-repository.js";
import { TaskWorker } from "../src/tasks/task-worker.js";
import { TaskEventRepository } from "../src/tasks/task-events.js";

process.env.FILE_STORAGE_DIR = process.env.FILE_STORAGE_DIR || "./storage-test";

let server: Server;
let baseUrl = "";
let token = "";
let userId = "";
let conversationId = "";
let taskId = "";

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(baseUrl + path, init);
}

async function json(response: Response): Promise<any> {
  return response.json();
}

describe("Friday backend integration", () => {
  before(async () => {
    await migrate();
    server = createServer(createApi());
    await new Promise<void>(resolve => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port.");
    baseUrl = "http://127.0.0.1:" + address.port;
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
  });

  it("serves health and readiness", async () => {
    const health = await request("/api/health");
    assert.equal(health.status, 200);
    assert.equal((await json(health)).ok, true);

    const ready = await request("/api/ready");
    assert.equal(ready.status, 200);
    assert.equal((await json(ready)).ready, true);
  });

  it("registers, authenticates, and revokes a session", async () => {
    const email = "integration-" + Date.now() + "@example.test";
    const register = await request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Strong-test-password-123!" })
    });
    assert.equal(register.status, 201);
    userId = (await json(register)).user.id;

    const login = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Strong-test-password-123!" })
    });
    assert.equal(login.status, 200);
    token = (await json(login)).token;
    assert.ok(token);

    const me = await request("/api/auth/me", {
      headers: { authorization: "Bearer " + token }
    });
    assert.equal(me.status, 200);
    assert.equal((await json(me)).user.id, userId);

    const logout = await request("/api/auth/logout", {
      method: "POST",
      headers: { authorization: "Bearer " + token }
    });
    assert.equal(logout.status, 204);

    const denied = await request("/api/auth/me", {
      headers: { authorization: "Bearer " + token }
    });
    assert.equal(denied.status, 401);

    const relogin = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Strong-test-password-123!" })
    });
    assert.equal(relogin.status, 200);
    token = (await json(relogin)).token;
  });

  it("persists conversations and messages with ownership checks", async () => {
    const created = await request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ title: "Integration conversation" })
    });
    assert.equal(created.status, 201);
    conversationId = (await json(created)).conversation.id;

    const message = await request("/api/conversations/" + conversationId + "/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ role: "user", content: "Hello Friday" })
    });
    assert.equal(message.status, 201);

    const messages = await request("/api/conversations/" + conversationId + "/messages", {
      headers: { authorization: "Bearer " + token }
    });
    assert.equal(messages.status, 200);
    assert.equal((await json(messages)).messages.length, 1);
  });

  it("stores and searches memory", async () => {
    const created = await request("/api/memories", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ content: "Friday backend integration memory" })
    });
    assert.equal(created.status, 201);

    const found = await request("/api/memories?q=integration+memory", {
      headers: { authorization: "Bearer " + token }
    });
    assert.equal(found.status, 200);
    assert.ok((await json(found)).memories.length >= 1);
  });

  it("uploads and reads an owned file preserving r and n characters in filename", async () => {
    const payload = Buffer.from("Friday integration file").toString("base64");
    const uploaded = await request("/api/files", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({
        name: "report-notes.txt",
        mimeType: "text/plain",
        contentBase64: payload
      })
    });
    assert.equal(uploaded.status, 201);
    const fileId = (await json(uploaded)).file.id;

    const downloaded = await request("/api/files/" + fileId, {
      headers: { authorization: "Bearer " + token }
    });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
    assert.match(downloaded.headers.get("content-disposition") ?? "", /filename="report-notes\.txt"/);
    assert.equal(await downloaded.text(), "Friday integration file");
  });

  it("rejects invalid UUID route parameters with 400", async () => {
    const badFile = await request("/api/files/not-a-uuid", {
      headers: { authorization: "Bearer " + token }
    });
    assert.equal(badFile.status, 400);

    const badEvents = await request("/api/tasks/not-a-uuid/events", {
      headers: { authorization: "Bearer " + token }
    });
    assert.equal(badEvents.status, 400);
  });

  it("persists projects, tools, user settings, and encrypted credentials", async () => {
    process.env.TOOL_ENCRYPTION_KEY = process.env.TOOL_ENCRYPTION_KEY || "integration-test-encryption-key";

    const projRes = await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({
        name: "Friday Phase 1",
        repositoryOwner: "jarvisbyak-pack",
        repositoryName: "friday-web-ui-phase-1-frontend"
      })
    });
    assert.equal(projRes.status, 201);
    const projectId = (await json(projRes)).project.id;

    const toolRes = await request("/api/projects/" + projectId + "/tools/github", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ enabled: true, configuration: { branch: "main" } })
    });
    assert.equal(toolRes.status, 200);

    const settingsRes = await request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ theme: "light", accentColor: "custom", accentCustomValue: "#ff6b4a" })
    });
    assert.equal(settingsRes.status, 200);
    assert.equal((await json(settingsRes)).settings.theme, "light");

    const credRes = await request("/api/credentials", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({
        projectId,
        toolKey: "github",
        credentialType: "pat",
        secret: "ghp_integration_secret_123"
      })
    });
    assert.equal(credRes.status, 201);
    const credBody = await json(credRes);
    assert.equal(credBody.credential.encrypted_secret, undefined);
    assert.equal(credBody.credential.secret, undefined);
  });

  it("queues a task and the worker completes it", async () => {
    const created = await request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ type: "integration-smoke", input: { ok: true } })
    });
    assert.equal(created.status, 202);
    taskId = (await json(created)).task.id;

    const worker = new TaskWorker(new PostgresTaskRepository(), 25, 30000);
    worker.start();
    try {
      const deadline = Date.now() + 5000;
      let state = "";
      while (Date.now() < deadline) {
        const response = await request("/api/tasks/" + taskId, {
          headers: { authorization: "Bearer " + token }
        });
        assert.equal(response.status, 200);
        state = (await json(response)).task.state;
        if (state === "completed") break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(state, "completed");

      const events = await new TaskEventRepository().listAfter(taskId, 0);
      assert.ok(events.some(event => event.type === "task.queued"));
      assert.ok(events.some(event => event.type === "task.running"));
      assert.ok(events.some(event => event.type === "task.completed"));
    } finally {
      worker.stop();
    }
  });
});