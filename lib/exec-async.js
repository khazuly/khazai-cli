import { spawn } from "node:child_process";

export function execAsync(command, { cwd, timeoutMs, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", String(command)], {
      cwd: String(cwd || process.cwd()),
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "", stderr = "";
    let killed = false;
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    const timer = timeoutMs ? setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        try { spawn("pkill", ["-9", "-g", String(child.pid)]); } catch {}
      }, 500);
    }, timeoutMs) : null;
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      if (killed) {
        const err = new Error("Timeout");
        err.killed = true;
        return reject(err);
      }
      if (code === 0) return resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      const err = new Error(`Exit: ${code}`);
      err.status = code; err.stdout = stdout; err.stderr = stderr;
      reject(err);
    });
    child.on("error", reject);
  });
}
