import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createApplication, listen } from "./http.js";

const PORT = 8765;
const data = new URL("../../data/", import.meta.url);
const url = `http://127.0.0.1:${PORT}`;

function openBrowser() {
  const browser = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url],
    { detached: true, stdio: "ignore", windowsHide: true });
  browser.on("error", () => console.log(`Open ${url} in your browser.`));
  browser.unref();
}

async function main() {
  let listener;
  try {
    listener = await listen(PORT);
  } catch (error) {
    const running = await fetch(`${url}/api/instance`, { signal: AbortSignal.timeout(1000) })
      .then(response => response.json()).catch(() => null);
    if (running?.app !== "TaleSide") throw error;
    if (running.runtime !== "node") throw new Error("Close the previous TaleSide launcher and start the app again.");
    console.log(`TaleSide is already running at ${url}.`);
    openBrowser();
    return;
  }

  const { server, origin } = listener;
  try {
    await mkdir(data, { recursive: true });
    const app = await createApplication(fileURLToPath(new URL("worlds.sqlite3", data)));
    server.on("request", (request, response) => app.handle(request, response, origin));
    const close = async () => {
      server.close();
      await app.close();
    };
    process.once("SIGINT", () => { void close(); });
    process.once("SIGTERM", () => { void close(); });
    console.log(`TaleSide is running at ${origin}. Close this launcher to stop it.`);
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
