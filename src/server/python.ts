import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RequestError } from "./validation.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

let executable: string | undefined;
export function pythonExecutable() {
  if (executable) return executable;
  if (process.platform !== "win32") return "python3";
  const located = spawnSync("py", ["-3.12", "-c", "import sys; print(sys.executable)"],
    { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (located.status !== 0 || !located.stdout?.trim()) {
    throw new RequestError("Install Python 3.12 with the Windows Python launcher, then start TaleSide again.", 503);
  }
  executable = located.stdout.trim();
  return executable;
}

export function pythonWorker(operation: "prepare" | "retrieve", signal?: AbortSignal) {
  const child = spawn(pythonExecutable(), [ "-B", "-u", "-X", "utf8", "-m", "taleside.node_worker", operation],
    { cwd: root, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const stream = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = stream[Symbol.asyncIterator]();
  const unavailable = () => new RequestError("Install Python 3.12 with the Windows Python launcher, then start TaleSide again.", 503);
  let startupFailed = false;
  child.once("error", () => { startupFailed = true; });
  child.stdin.on("error", () => {});
  const close = () => {
    signal?.removeEventListener("abort", close);
    stream.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  if (signal?.aborted) close();
  else signal?.addEventListener("abort", close, { once: true });

  return {
    async send(value: object) {
      signal?.throwIfAborted();
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdin.write(JSON.stringify(value) + "\n", error => error ? reject(error) : resolve());
        });
      } catch {
        signal?.throwIfAborted();
        throw unavailable();
      }
    },
    async receive<T>() {
      const packet = await lines.next();
      signal?.throwIfAborted();
      if (packet.done || startupFailed) throw unavailable();
      const result = JSON.parse(packet.value);
      if (result.error) throw new RequestError(result.error, result.status ?? 500);
      return result as T;
    },
    close,
  };
}
