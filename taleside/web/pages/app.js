import { createDemoWorlds, updateDemoProgress } from "./home/demo-worlds.js";
import { renderHome, resetHomeSelection, showHomeMessage } from "./home/home.js";

const mode = document.getElementById("world-preview-mode");
const pending = new Map();
let savedWorlds = null;
let demos = createDemoWorlds().map(updateDemoProgress);
let requestNumber = 0;
let worldRequest = null;
let connectionError = false;

async function request(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const body = await response.json().catch(() => null);
  if (response.ok && body) return body;
  const error = new Error(body?.error ?? "Could not connect to TaleSide.");
  error.status = response.status;
  throw error;
}

function isDemo(id) {
  return id.startsWith("demo-");
}

function updateHome() {
  const worlds = mode.value === "demo" ? demos : mode.value === "saved" ? savedWorlds ?? [] : [];
  renderHome(worlds, mode.value === "saved" && savedWorlds === null, pending, card => changeJob(card.world));
}

function refreshWorlds(force = false) {
  if (worldRequest && !force) return worldRequest;
  const number = ++requestNumber;
  worldRequest = request("/api/worlds").then(worlds => {
    if (number !== requestNumber) return;
    savedWorlds = worlds;
    if (connectionError) showHomeMessage("");
    connectionError = false;
    updateHome();
  }).catch(() => {
    if (number !== requestNumber) return;
    connectionError = true;
    showHomeMessage("Could not connect to TaleSide.");
  }).finally(() => {
    if (number === requestNumber) worldRequest = null;
  });
  return worldRequest;
}

async function changeJob(world) {
  const { id, status } = world;
  if (status === "ready" || status === "pausing" || pending.has(id)) return;
  const action = status === "creating" ? "pause" : "resume";
  if (isDemo(id)) {
    world.status = action === "pause" ? "pausing" : "creating";
    world.error = null;
    updateDemoProgress(world);
    updateHome();
    if (action === "pause") setTimeout(() => {
      world.status = "paused";
      updateDemoProgress(world);
      if (demos.includes(world)) updateHome();
    }, 650);
    return;
  }

  pending.set(id, action);
  updateHome();
  try {
    await request(`/api/worlds/${id}/${action}`, { method: "POST" });
    showHomeMessage("");
  } catch (error) {
    if (error.status !== 409) {
      showHomeMessage(error.message);
    }
  } finally {
    await refreshWorlds(true);
    pending.delete(id);
    updateHome();
  }
}

mode.addEventListener("change", () => {
  if (mode.value === "demo") {
    demos = createDemoWorlds().map(updateDemoProgress);
    for (const world of demos) new Image().src = world.wide;
  }
  resetHomeSelection();
  updateHome();
});
updateHome();
refreshWorlds();
setInterval(refreshWorlds, 1200);
setInterval(() => {
  if (mode.value !== "demo") return;
  const creating = demos.filter(world => world.status === "creating");
  if (!creating.length) return;
  for (const world of creating) {
    world.progress += 1;
    if (world.progress === 100) world.status = "ready";
    updateDemoProgress(world);
  }
  updateHome();
}, 1400);
