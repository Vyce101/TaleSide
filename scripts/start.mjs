import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const [major, minor, patch] = process.versions.node.split(".").map(Number);
const compiler = "node_modules/typescript/bin/tsc";
const packages = [compiler, "node_modules/@types/node/package.json", "node_modules/undici-types/package.json"];

if (major !== 24 || minor < 11 || (minor === 11 && patch < 1)) {
  console.error("Install Node.js 24 LTS (24.11.1 or later), then start TaleSide again.");
  process.exitCode = 1;
} else if (!packages.every(path => existsSync(path))) {
  console.error("Run npm ci in the TaleSide folder, then start TaleSide again.");
  process.exitCode = 1;
} else {
  const output = [];
  const build = spawn(process.execPath, [compiler, "-p", "tsconfig.json"], { windowsHide: true });
  build.stdout.on("data", chunk => output.push(chunk));
  build.stderr.on("data", chunk => output.push(chunk));
  build.on("error", error => output.push(Buffer.from(error.message)));
  const notice = setTimeout(() => console.log("Preparing TaleSide…"), 800);
  build.on("close", async code => {
    clearTimeout(notice);
    if (code !== 0) {
      console.error("TaleSide could not build. Review the details below.");
      if (output.length) process.stderr.write(Buffer.concat(output));
      process.exitCode = 1;
      return;
    }
    await import("../dist/server/main.js");
  });
}
