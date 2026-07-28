import { spawn } from "node:child_process";

export function execAsync(command, { cwd, timeoutMs, env, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", String(command)], {
      cwd: String(cwd || process.cwd()),
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "", stderr = "";
    let termination = "";
    let forceTimer = null;
    let settled = false;
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    const terminate = message => {
      if (termination) return;
      termination = message;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      forceTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, 500);
      forceTimer.unref?.();
    };
    const abort = () => terminate(signal?.reason?.message || "Cancelled");
    const timer = timeoutMs
      ? setTimeout(() => terminate(`Timed out after ${timeoutMs}ms`), timeoutMs)
      : null;
    timer?.unref?.();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
    };
    child.on("close", code => {
      if (settled) return;
      settled = true;
      cleanup();
      if (termination) {
        const err = new Error(termination);
        err.killed = true;
        err.status = -1;
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      if (code === 0) return resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      const err = new Error(`Exit: ${code}`);
      err.status = code; err.stdout = stdout; err.stderr = stderr;
      reject(err);
    });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}
