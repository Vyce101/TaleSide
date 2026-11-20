import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const allowed = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "CC0-1.0", "Unlicense", "PSF-2.0"]);

for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path) continue;
  const metadata = JSON.parse(readFileSync(new URL(`../${path}/package.json`, import.meta.url), "utf8"));
  if (metadata.version !== entry.version || !allowed.has(metadata.license)) {
    console.error(`${path}: review ${metadata.version} (${metadata.license ?? "unknown license"})`);
    process.exitCode = 1;
  } else {
    console.log(`${path} ${metadata.version} ${metadata.license}`);
  }
}
