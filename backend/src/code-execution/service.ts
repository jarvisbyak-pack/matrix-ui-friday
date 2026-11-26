import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { config } from "../config.js";

export type CodeExecutionResult = {
  command: string[];
  cwd: string;
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function allowedCommands(): string[] {
  return config.CODE_ALLOWED_COMMANDS.split(",").map(value => value.trim()).filter(Boolean);
}

function assertAllowed(command: string[]): void {
  if (!config.FRIDAY_ALLOW_CODE_EXECUTION) {
    throw new Error("Code execution is disabled. Set FRIDAY_ALLOW_CODE_EXECUTION=true only when authorized.");
  }
  const normalized = command.join(" ").trim();
  if (!normalized || !allowedCommands().includes(normalized)) {
    throw new Error(`Command is not allowed. Allowed commands: ${allowedCommands().join(", ")}`);
  }
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export class CodeExecutionService {
  async run(command: string[], cwd?: string, timeoutMs?: number): Promise<CodeExecutionResult> {
    if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== "string")) {
      throw new Error("command must be a non-empty string array.");
    }
    assertAllowed(command);

    const root = await realpath(resolve(config.CODE_WORKSPACE_ROOT));
    const workdir = await realpath(resolve(root, cwd ?? "."));
    if (workdir !== root && !workdir.startsWith(root + sep)) {
      throw new Error("Working directory must remain inside CODE_WORKSPACE_ROOT.");
    }

    const timeout = Number.isFinite(timeoutMs)
      ? Math.min(Math.max(Math.trunc(timeoutMs!), 1000), config.CODE_COMMAND_TIMEOUT_MS)
      : config.CODE_COMMAND_TIMEOUT_MS;
    const [executable, ...args] = command;

    return new Promise((resolvePromise, reject) => {
      const useDetached = process.platform !== "win32";
      const child = spawn(executable!, args, {
        cwd: workdir,
        shell: false,
        windowsHide: true,
        detached: useDetached,
        env: minimalEnvironment()
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;

      const append = (target: "stdout" | "stderr", chunk: Buffer) => {
        const list = target === "stdout" ? stdoutChunks : stderrChunks;
        list.push(chunk);
        if (target === "stdout") stdoutBytes += chunk.byteLength;
        else stderrBytes += chunk.byteLength;
        const limit = config.CODE_MAX_OUTPUT_BYTES;
        while ((target === "stdout" ? stdoutBytes : stderrBytes) > limit && list.length > 1) {
          const dropped = list.shift()!;
          if (target === "stdout") stdoutBytes -= dropped.byteLength;
          else stderrBytes -= dropped.byteLength;
        }
      };

      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

      const killProcessGroup = (signal: NodeJS.Signals) => {
        try {
          if (useDetached && child.pid) {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          // Process may have already exited.
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup("SIGTERM");
        killTimer = setTimeout(() => killProcessGroup("SIGKILL"), 2000);
      }, timeout);

      child.on("error", error => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });

      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolvePromise({
          command,
          cwd: workdir,
          exitCode,
          ...(signal ? { signal } : {}),
          stdout: Buffer.concat(stdoutChunks).toString("utf8").slice(-config.CODE_MAX_OUTPUT_BYTES),
          stderr: Buffer.concat(stderrChunks).toString("utf8").slice(-config.CODE_MAX_OUTPUT_BYTES),
          timedOut
        });
      });
    });
  }
}
