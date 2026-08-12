import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { abortError, throwIfAborted } from "./abort.js";

export interface AbortableProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
  signal?: AbortSignal;
}

export interface AbortableProcessResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class AbortableProcessError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | string | null;

  constructor(message: string, result: { stdout: string; stderr: string; code: number | string | null }) {
    super(message);
    this.name = "AbortableProcessError";
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.code = result.code;
  }
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function collect(stream: Readable | null, maxBytes: number, onOverflow: () => void): { text: () => string } {
  const chunks: Buffer[] = [];
  let retained = 0;
  let seen = 0;
  stream?.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    seen += buffer.byteLength;
    if (retained < maxBytes) {
      const portion = buffer.subarray(0, Math.max(0, maxBytes - retained));
      chunks.push(portion);
      retained += portion.byteLength;
    }
    if (seen > maxBytes) onOverflow();
  });
  return { text: () => Buffer.concat(chunks).toString("utf8") };
}

/** Execute one file with an abort-aware process group so npm/shell grandchildren are stopped too. */
export async function execFileAbortable(file: string, args: readonly string[], options: AbortableProcessOptions = {}): Promise<AbortableProcessResult> {
  throwIfAborted(options.signal);
  const maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let terminationError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let outputOverflow = false;

    const terminate = (error: Error) => {
      if (terminationError) return;
      terminationError = error;
      try {
        terminateProcessTree(child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      killTimer = setTimeout(() => {
        try {
          terminateProcessTree(child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 1000);
      killTimer.unref();
    };
    const overflow = () => {
      if (outputOverflow) return;
      outputOverflow = true;
      terminate(new Error(`Process output exceeded ${maxBufferBytes} bytes.`));
    };
    const stdout = collect(child.stdout, maxBufferBytes, overflow);
    const stderr = collect(child.stderr, maxBufferBytes, overflow);
    const onAbort = () => terminate(abortError(options.signal!));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    if (options.timeoutMs) {
      timeout = setTimeout(() => terminate(new Error(`${file} timed out after ${options.timeoutMs}ms.`)), options.timeoutMs);
      timeout.unref();
    }

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      cleanup();
      reject(new AbortableProcessError(error.message, { stdout: stdout.text(), stderr: stderr.text(), code: (error as NodeJS.ErrnoException).code ?? null }));
    });
    child.once("close", (code, signal) => {
      cleanup();
      const result = { stdout: stdout.text(), stderr: stderr.text(), code: code ?? -1 };
      if (terminationError) {
        reject(new AbortableProcessError(terminationError.message, { ...result, code: signal ?? code }));
      } else if (code !== 0) {
        reject(new AbortableProcessError(`${file} exited with code ${code}.`, result));
      } else {
        resolve(result);
      }
    });
  });
}
