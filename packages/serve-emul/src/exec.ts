import { spawn } from "node:child_process";

// All adb/emulator subprocess work must stay OFF the event loop. `Bun.serve`
// runs the video frame pump on the same single JS thread, so a synchronous
// `spawnSync` freezes streaming for the whole adb round-trip. Every feature
// query/mutation goes through these async helpers instead, and a small
// concurrency gate keeps a burst of requests from spawning dozens of adb
// processes at once (which would overload adbd and stall responses).

const MAX_CONCURRENT = 4;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

let active = 0;
type ExecWaiter = {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const waiters: ExecWaiter[] = [];

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: ExecWaiter = { resolve, reject, signal };
    if (signal) {
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index === -1) return;
        waiters.splice(index, 1);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    waiters.push(waiter);
  });
}

function release(): void {
  while (waiters.length > 0) {
    const next = waiters.shift()!;
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    if (next.signal?.aborted) {
      next.reject(abortReason(next.signal));
      continue;
    }
    next.resolve();
    return;
  }
  active--;
}

export type ExecOpts = {
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
};

export type ExecResult<T extends string | Buffer> = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: T;
  stderr: string;
  timedOut: boolean;
  error: Error | null;
};

function run<T extends string | Buffer>(
  cmd: string,
  args: string[],
  opts: ExecOpts,
  encoding: "utf8" | "buffer",
): Promise<ExecResult<T>> {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise<ExecResult<T>>((resolve) => {
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let settled = false;
    let timedOut = false;
    let terminationError: Error | null = null;

    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    const terminate = (error: Error) => {
      if (!terminationError) terminationError = error;
      try {
        child.kill("SIGKILL");
      } catch {}
    };

    const timer = opts.timeout
      ? setTimeout(() => {
          timedOut = true;
          terminate(new Error(`${cmd} timed out after ${opts.timeout}ms`));
        }, opts.timeout)
      : null;

    const onAbort = opts.signal
      ? () => terminate(abortReason(opts.signal!))
      : null;
    opts.signal?.addEventListener("abort", onAbort!, { once: true });

    const finish = (status: number | null, signal: NodeJS.Signals | null, error: Error | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
      const stdoutBuf = Buffer.concat(outChunks);
      resolve({
        status,
        signal,
        stdout: (encoding === "buffer" ? stdoutBuf : stdoutBuf.toString("utf8")) as T,
        stderr: Buffer.concat(errChunks).toString("utf8"),
        timedOut,
        error: terminationError ?? error,
      });
    };

    if (opts.signal?.aborted) onAbort?.();

    child.stdout.on("data", (d: Buffer) => {
      outLen += d.length;
      if (outLen > maxBuffer) {
        terminate(new Error("maxBuffer exceeded"));
        return;
      }
      outChunks.push(d);
    });
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));
    child.once("error", (err) => finish(null, null, err));
    child.once("close", (status, signal) => finish(status, signal, null));
  });
}

async function execGated<T extends string | Buffer>(
  cmd: string,
  args: string[],
  opts: ExecOpts,
  encoding: "utf8" | "buffer",
): Promise<ExecResult<T>> {
  try {
    await acquire(opts.signal);
  } catch (error) {
    return {
      status: null,
      signal: null,
      stdout: (encoding === "buffer" ? Buffer.alloc(0) : "") as T,
      stderr: "",
      timedOut: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  try {
    if (opts.signal?.aborted) {
      return {
        status: null,
        signal: null,
        stdout: (encoding === "buffer" ? Buffer.alloc(0) : "") as T,
        stderr: "",
        timedOut: false,
        error: abortReason(opts.signal),
      };
    }
    return await run<T>(cmd, args, opts, encoding);
  } finally {
    release();
  }
}

export function execText(cmd: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult<string>> {
  return execGated<string>(cmd, args, opts, "utf8");
}

export function execBuffer(cmd: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult<Buffer>> {
  return execGated<Buffer>(cmd, args, opts, "buffer");
}
