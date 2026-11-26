(() => {
  const pathScope = (() => {
    const dir = (window.location.pathname || "/")
      .replace(/\/[^/]*$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return dir || "root";
  })();

  const STORAGE_KEY = "friday_api_url:" + pathScope;
  const TOKEN_KEY = "friday_auth_token:" + pathScope;
  const CONVERSATION_KEY = "friday_conversation_id:" + pathScope;

  const tokenStore = () => (window.FRIDAY_CONFIG?.TOKEN_STORAGE === "session" ? window.sessionStorage : window.localStorage);

  const normalizeBase = value => {
    const raw = (value || "").trim();
    if (!raw) return "/api";
    if (raw === "/api" || raw.startsWith("/api/")) return "/api";
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("Backend URL must be a valid https:// URL.");
    }
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(isLocal && parsed.protocol === "http:")) {
      throw new Error("Backend URL must use HTTPS (HTTP is only allowed for localhost).");
    }
    if (parsed.username || parsed.password) {
      throw new Error("Backend URL must not include embedded credentials.");
    }
    const clean = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
    return clean.endsWith("/api") ? clean : clean + "/api";
  };

  const getConfiguredApiBase = () => {
    const runtime = window.FRIDAY_CONFIG?.API_BASE_URL;
    if (runtime) return runtime;
    const build = "__FRIDAY_API_BASE_URL__";
    return build !== "__FRIDAY_API_BASE_URL__" ? build : "";
  };

  const getApiBase = () => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const configured = getConfiguredApiBase();
    if (stored) {
      try {
        return normalizeBase(stored);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    if (configured) return normalizeBase(configured);
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") return "/api";
    throw new Error("Friday backend URL is not configured for this deployment.");
  };

  const setApiBase = value => {
    const normalized = normalizeBase(value);
    localStorage.setItem(STORAGE_KEY, normalized);
    return normalized;
  };

  const getToken = () => tokenStore().getItem(TOKEN_KEY) || "";
  const setToken = token => (token ? tokenStore().setItem(TOKEN_KEY, token) : tokenStore().removeItem(TOKEN_KEY));
  const getConversationId = () => localStorage.getItem(CONVERSATION_KEY) || "";
  const setConversationId = id => (id ? localStorage.setItem(CONVERSATION_KEY, id) : localStorage.removeItem(CONVERSATION_KEY));

  async function request(path, options = {}) {
    const { baseUrlOverride, ...fetchOptions } = options;
    const headers = new Headers(fetchOptions.headers || {});
    if (fetchOptions.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const token = getToken();
    if (token && !baseUrlOverride) headers.set("Authorization", "Bearer " + token);

    const base = baseUrlOverride ? normalizeBase(baseUrlOverride) : getApiBase();
    let response;
    try {
      response = await fetch(base + path, { ...fetchOptions, headers });
    } catch {
      throw new Error("Friday backend is unreachable. Check the API URL in Settings.");
    }

    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : await response.text();

    if (!response.ok) {
      const message = payload && typeof payload === "object" && payload.error?.message
        ? payload.error.message
        : "Request failed (" + response.status + ").";
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function health(baseUrlOverride) {
    return request("/health", {
      headers: { Accept: "application/json" },
      ...(baseUrlOverride ? { baseUrlOverride } : {})
    });
  }

  async function register(email, password) {
    return request("/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });
  }

  async function login(email, password) {
    const result = await request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    setToken(result.token);
    return result;
  }

  async function exchangeOAuthCode(code) {
    const result = await request("/auth/oauth/exchange", { method: "POST", body: JSON.stringify({ code }) });
    setToken(result.token);
    return result;
  }

  function startOAuth(provider) {
    if (provider !== "google" && provider !== "github") {
      throw new Error("Unsupported OAuth provider.");
    }
    const redirectTo = window.location.origin + window.location.pathname;
    window.location.assign(
      getApiBase() + "/auth/" + encodeURIComponent(provider) + "/start?redirect_to=" + encodeURIComponent(redirectTo)
    );
  }

  async function me() {
    return request("/auth/me");
  }

  async function logout() {
    try {
      if (getToken()) await request("/auth/logout", { method: "POST" });
    } catch {
      // Clear local session even if backend logout fails transiently.
    } finally {
      setToken("");
      setConversationId("");
    }
  }

  async function listConversations() {
    return request("/conversations");
  }

  async function createConversation(title) {
    const result = await request("/conversations", {
      method: "POST",
      body: JSON.stringify({ title })
    });
    setConversationId(result.conversation.id);
    return result;
  }

  async function listMessages(id) {
    return request("/conversations/" + encodeURIComponent(id) + "/messages");
  }

  async function addMessage(id, role, content, metadata) {
    return request("/conversations/" + encodeURIComponent(id) + "/messages", {
      method: "POST",
      body: JSON.stringify({ role, content, metadata })
    });
  }

  async function createAgentTask(messages, options = {}) {
    return request("/tasks", {
      method: "POST",
      body: JSON.stringify({
        type: "agent",
        input: {
          messages,
          model: options.model,
          temperature: options.temperature,
          maxSteps: options.maxSteps || 8,
          ...(options.projectId ? { projectId: options.projectId } : {})
        }
      })
    });
  }

  async function getTask(id) {
    return request("/tasks/" + encodeURIComponent(id));
  }

  async function cancelTask(id) {
    return request("/tasks/" + encodeURIComponent(id) + "/cancel", { method: "POST" });
  }

  async function listTasks() {
    return request("/tasks");
  }

  async function readTaskEvents(id, after, onEvent, signal) {
    const headers = new Headers({ Accept: "text/event-stream" });
    const token = getToken();
    if (token) headers.set("Authorization", "Bearer " + token);

    let response;
    try {
      response = await fetch(
        getApiBase() + "/tasks/" + encodeURIComponent(id) + "/events?after=" + encodeURIComponent(after || 0),
        { headers, signal }
      );
    } catch {
      if (signal?.aborted) return;
      throw new Error("Unable to connect to the task event stream.");
    }

    if (!response.ok || !response.body) {
      throw new Error("Task event stream failed (" + response.status + ").");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        let eventName = "message";
        const dataLines = [];
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length || eventName === "error") continue;
        try {
          const parsed = JSON.parse(dataLines.join("\n"));
          if (parsed && typeof parsed.type === "string") {
            onEvent(parsed);
          }
        } catch {
          // Ignore malformed individual events; the task status remains authoritative.
        }
      }
    }
  }

  async function uploadFile(file) {
    const contentBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("Could not read " + file.name));
      reader.readAsDataURL(file);
    });

    return request("/files", {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        contentBase64
      })
    });
  }

  async function listFiles() {
    return request("/files");
  }

  async function downloadFile(id) {
    const headers = new Headers();
    const token = getToken();
    if (token) headers.set("Authorization", "Bearer " + token);

    const response = await fetch(getApiBase() + "/files/" + encodeURIComponent(id), { headers });
    if (!response.ok) {
      throw new Error("File download failed (" + response.status + ").");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/i);
    return { blob, filename: match ? match[1] : "download" };
  }

  async function listProjects() {
    return request("/projects");
  }

  async function listTools() {
    return request("/tools");
  }

  async function searchMemories(query) {
    return request("/memories?q=" + encodeURIComponent(query));
  }

  async function getSettings() {
    return request("/settings");
  }

  async function updateSettings(patch) {
    return request("/settings", { method: "PUT", body: JSON.stringify(patch) });
  }

  window.FridayApi = {
    getApiBase, setApiBase, normalizeBase, getToken, getConversationId, setConversationId,
    health, register, login, exchangeOAuthCode, startOAuth, me, logout,
    listConversations, createConversation, listMessages, addMessage,
    createAgentTask, getTask, cancelTask, listTasks, readTaskEvents, uploadFile,
    listFiles, downloadFile, listProjects, listTools, searchMemories,
    getSettings, updateSettings
  };
})();
