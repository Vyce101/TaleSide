import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createApplication, listen } from "./http.js";
import { pythonExecutable } from "./python.js";

const PORT = 8765;
const data = new URL("../../data/", import.meta.url);
const url = `http://127.0.0.1:${PORT}`;

function openBrowser() {
  const browser = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url],
    { detached: true, stdio: "ignore", windowsHide: true });
  browser.on("error", () => console.log(`Open ${url} in your browser.`));
  browser.unref();
}

function runningStatus(address: string, alreadyRunning = false) {
  const color = process.stdout.isTTY && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";
  const heading = color ? "\x1b[1;32mTaleSide\x1b[0m" : "TaleSide";
  console.log([`\n${heading}`, alreadyRunning ? "Already running." : "Running.", address,
    alreadyRunning ? "Use the original launcher window to stop TaleSide." : "Keep this window open while using TaleSide. Press Ctrl+C to stop.", ""].join("\n"));
}

async function main() {
  pythonExecutable();
  let listener;
  try {
    listener = await listen(PORT);
  } catch (error) {
    const running = await fetch(`${url}/api/instance`, { signal: AbortSignal.timeout(1000) })
      .then(response => response.json()).catch(() => null);
    if (running?.app !== "TaleSide") {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new Error(`Close the app using port ${PORT}, then start TaleSide again.`);
      }
      throw error;
    }
    if (running.runtime !== "node") throw new Error("Close the previous TaleSide launcher and start the app again.");
    runningStatus(url, true);
    openBrowser();
    return;
  }

  const { server, origin } = listener;
  try {
    await mkdir(data, { recursive: true });
    const app = await createApplication(fileURLToPath(new URL("worlds.sqlite3", data)), {
      onBackup: () => console.log("Backing up the local database before upgrading…"),
    });
    server.on("request", (request, response) => app.handle(request, response, origin));
    let stopping = false;
    const close = async () => {
      if (stopping) return;
      stopping = true;
      console.log("Stopping TaleSide and saving active work…");
      server.close();
      await app.close();
    };
    process.once("SIGINT", () => { void close(); });
    process.once("SIGTERM", () => { void close(); });
    runningStatus(origin);
    openBrowser();
  } catch (error) {
    server.close();
    throw error;
  }
}

main().catch(error => {
  console.error("Could not start TaleSide.", error instanceof Error ? error.message : "");
  process.exitCode = 1;
});
