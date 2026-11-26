import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentCancelledError, AgentService } from "../src/agent/service.js";
import { GeminiProvider } from "../src/ai/gemini-provider.js";
import { isEmailPermittedForSignup } from "../src/auth/service.js";
import { CodeExecutionService } from "../src/code-execution/service.js";
import { config } from "../src/config.js";
import { CredentialService } from "../src/credentials/service.js";
import { GitHubClient } from "../src/github/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { resolveGitHubTokenForContext } from "../src/tools/github.js";
import type { Tool } from "../src/tools/types.js";
import type { AiProvider } from "../src/ai/types.js";
import { isPrivateOrReservedIp, WebFetchService } from "../src/web/service.js";

describe("Friday backend safety and agent seams", () => {
  it("runs an agent tool call and returns the final provider response", async () => {
    let calls = 0;
    const provider: AiProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 1) {
          return {
            text: "",
            provider: "fake",
            model: "fake-model",
            toolCalls: [{ id: "tool-1", name: "echo", input: { value: "ok" } }]
          };
        }
        assert.ok(request.messages.some(message => message.role === "tool"));
        return { text: "done", provider: "fake", model: "fake-model", toolCalls: [] };
      }
    };

    const registry = new ToolRegistry();
    const echo: Tool = {
      definition: {
        name: "echo",
        description: "test echo",
        inputSchema: { type: "object" }
      },
      async execute(input) {
        return input;
      }
    };
    registry.register(echo);

    const result = await new AgentService(provider, registry).run({
      messages: [{ role: "user", content: "test" }]
    });

    assert.equal(result.text, "done");
    assert.equal(result.steps, 2);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolResults.length, 1);
  });

  it("preserves toolResult metadata when a tool throws", async () => {
    let calls = 0;
    const provider: AiProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 1) {
          return {
            text: "",
            provider: "fake",
            model: "fake-model",
            toolCalls: [{ id: "tool-err-1", name: "boom", input: {} }]
          };
        }
        const toolMessage = request.messages.find(message => message.role === "tool");
        assert.equal(toolMessage?.toolResult?.name, "boom");
        assert.equal(toolMessage?.toolResult?.toolCallId, "tool-err-1");
        assert.match(toolMessage?.toolResult?.error ?? "", /exploding/);
        return { text: "recovered", provider: "fake", model: "fake-model", toolCalls: [] };
      }
    };

    const registry = new ToolRegistry();
    registry.register({
      definition: { name: "boom", description: "fails", inputSchema: { type: "object" } },
      async execute() {
        throw new Error("exploding tool");
      }
    });

    const result = await new AgentService(provider, registry).run({
      messages: [{ role: "user", content: "test error" }]
    });
    assert.equal(result.text, "recovered");
  });

  it("aborts agent execution when cancelled", async () => {
    const provider: AiProvider = {
      async generate() {
        return { text: "should not reach", provider: "fake", model: "fake", toolCalls: [] };
      }
    };
    await assert.rejects(
      () => new AgentService(provider, new ToolRegistry()).run({
        messages: [{ role: "user", content: "test" }],
        isCancelled: () => true
      }),
      AgentCancelledError
    );
  });

  it("groups multi-tool responses and sends Gemini API key via header", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok" }] } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const gemini = new GeminiProvider("secret-gemini-key", "gemini-2.5-flash");
      await gemini.generate({
        messages: [
          { role: "system", content: "sys-1" },
          { role: "system", content: "sys-2" },
          { role: "user", content: "run two tools" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "c1", name: "t1", input: {} },
              { id: "c2", name: "t2", input: {} }
            ]
          },
          { role: "tool", content: "{}", toolResult: { toolCallId: "c1", name: "t1", result: { a: 1 } } },
          { role: "tool", content: "{}", toolResult: { toolCallId: "c2", name: "t2", error: "failed" } }
        ]
      });

      assert.equal(capturedUrl.includes("secret-gemini-key"), false);
      assert.equal(capturedHeaders["x-goog-api-key"], "secret-gemini-key");
      assert.equal(capturedBody.systemInstruction.parts.length, 2);
      const lastTurn = capturedBody.contents[capturedBody.contents.length - 1];
      assert.equal(lastTurn.role, "user");
      assert.equal(lastTurn.parts.length, 2);
      assert.equal(lastTurn.parts[0].functionResponse.name, "t1");
      assert.deepEqual(lastTurn.parts[1].functionResponse.response, { error: "failed" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed for GitHub mutations and validates repo paths", async () => {
    await assert.rejects(
      () => new GitHubClient().createBranch("example/repo", "test-branch"),
      /mutations are disabled/i
    );
    await assert.rejects(
      () => new GitHubClient().getFile("../../user/emails", "README.md", undefined, "tok"),
      /owner\/name/i
    );
    await assert.rejects(
      () => new GitHubClient().getFile("owner/repo?x=1", "README.md", undefined, "tok"),
      /owner\/name/i
    );
  });

  it("scopes shared GITHUB_TOKEN away from non-owner accounts by default", async () => {
    const prevToken = config.GITHUB_TOKEN;
    const prevShared = config.GITHUB_ALLOW_SHARED_TOKEN;
    const prevOwners = config.OWNER_EMAILS;
    try {
      (config as { GITHUB_TOKEN?: string }).GITHUB_TOKEN = "server-pat";
      (config as { GITHUB_ALLOW_SHARED_TOKEN: boolean }).GITHUB_ALLOW_SHARED_TOKEN = false;
      (config as { OWNER_EMAILS: string }).OWNER_EMAILS = "owner@example.test";

      await assert.rejects(
        () => resolveGitHubTokenForContext({ userEmail: "stranger@example.test" }),
        /disabled for non-owner/i
      );
      assert.equal(
        await resolveGitHubTokenForContext({ userEmail: "owner@example.test" }),
        "server-pat"
      );
    } finally {
      (config as { GITHUB_TOKEN?: string }).GITHUB_TOKEN = prevToken;
      (config as { GITHUB_ALLOW_SHARED_TOKEN: boolean }).GITHUB_ALLOW_SHARED_TOKEN = prevShared;
      (config as { OWNER_EMAILS: string }).OWNER_EMAILS = prevOwners;
    }
  });

  it("encrypts and decrypts tool credentials and fails closed without key", () => {
    const service = new CredentialService("test-master-encryption-key-123");
    const cipher = service.encryptSecret("ghp_example_secret_token");
    assert.ok(!cipher.includes("ghp_example_secret_token"));
    assert.equal(service.decryptSecret(cipher), "ghp_example_secret_token");

    const unconfigured = new CredentialService("");
    assert.throws(() => unconfigured.encryptSecret("abc"), /TOOL_ENCRYPTION_KEY/);
  });

  it("enforces signup allowlist when configured", () => {
    const prevPublic = config.ALLOW_PUBLIC_REGISTRATION;
    const prevAllowed = config.ALLOWED_USER_EMAILS;
    const prevOwners = config.OWNER_EMAILS;
    try {
      (config as { ALLOW_PUBLIC_REGISTRATION: boolean }).ALLOW_PUBLIC_REGISTRATION = false;
      (config as { ALLOWED_USER_EMAILS: string }).ALLOWED_USER_EMAILS = "alice@example.test";
      (config as { OWNER_EMAILS: string }).OWNER_EMAILS = "owner@example.test";

      assert.equal(isEmailPermittedForSignup("alice@example.test"), true);
      assert.equal(isEmailPermittedForSignup("owner@example.test"), true);
      assert.equal(isEmailPermittedForSignup("eve@example.test"), false);
    } finally {
      (config as { ALLOW_PUBLIC_REGISTRATION: boolean }).ALLOW_PUBLIC_REGISTRATION = prevPublic;
      (config as { ALLOWED_USER_EMAILS: string }).ALLOWED_USER_EMAILS = prevAllowed;
      (config as { OWNER_EMAILS: string }).OWNER_EMAILS = prevOwners;
    }
  });

  it("fails closed for code execution by default", async () => {
    await assert.rejects(
      () => new CodeExecutionService().run(["npm", "test"]),
      /code execution is disabled/i
    );
  });

  it("blocks local, IPv6, mapped, CGNAT, and credential web targets", async () => {
    assert.equal(isPrivateOrReservedIp("[::1]"), true);
    assert.equal(isPrivateOrReservedIp("::ffff:127.0.0.1"), true);
    assert.equal(isPrivateOrReservedIp("::ffff:7f00:1"), true);
    assert.equal(isPrivateOrReservedIp("fe80::1"), true);
    assert.equal(isPrivateOrReservedIp("100.64.0.1"), true);
    assert.equal(isPrivateOrReservedIp("0.0.0.0"), true);
    assert.equal(isPrivateOrReservedIp("93.184.216.34"), false);

    const web = new WebFetchService();
    for (const url of [
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
      "http://[::ffff:127.0.0.1]/",
      "http://0.0.0.0:3001/",
      "http://100.64.0.1/",
      "http://[fe80::1]/",
      "http://user:pass@example.com/"
    ]) {
      await assert.rejects(() => web.fetchText(url), /not allowed|private|local|credentials/i);
    }
  });
});
