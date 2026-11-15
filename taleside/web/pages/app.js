import { showArtwork } from "./artwork.js";
import { initNavigation } from "./navigation.js";
import { initWorldScreen } from "./world/screen.js";
import { createDemoWorlds, updateDemoProgress } from "./home/demo-worlds.js";
import { renderHome, resetHomeSelection, revealHomeCard, selectWorld, showHomeMessage } from "./home/home.js";

const home = document.getElementById("home");
const studio = document.getElementById("studio");
const preview = document.querySelector(".preview-controls");
const mode = document.getElementById("world-preview-mode");
const header = document.querySelector(".top-bar");
const worldsLink = document.getElementById("worlds-link");
const createLink = document.getElementById("create-link");
const worldTop = document.getElementById("world-top");
const worldTopSpacer = document.getElementById("world-top-spacer");
const canopy = document.getElementById("studio-canopy");
const pending = new Map();
let savedWorlds = null;
let demos = createDemoWorlds().map(updateDemoProgress);
let requestNumber = 0;
let worldRequest = null;
let connectionError = false;
let expandedHeight = 0;

async function request(path, { json, ...options } = {}) {
  if (json !== undefined) {
    options.body = JSON.stringify(json);
    options.headers = { "Content-Type": "application/json" };
  }
  const response = await fetch(path, { cache: "no-store", ...options });
  const body = await response.json().catch(() => null);
  if (response.ok && body) return body;
  const error = new Error(body?.error ?? "Could not connect to TaleSide.");
  error.status = response.status;
  throw error;
}

const worldScreen = initWorldScreen({ request, onCreated, rename, discard, changeJob });
const navigation = initNavigation({
  display,
  confirmLeave: worldScreen.confirmLeave,
  isDirty: worldScreen.isDirty,
});

function isDemo(id) {
  return id.startsWith("demo-");
}

function updateHome() {
  const worlds = mode.value === "demo" ? demos : mode.value === "saved" ? savedWorlds ?? [] : [];
  renderHome(worlds, mode.value === "saved" && savedWorlds === null, pending, card => changeJob(card.world));
}

function updateWorld() {
  const id = navigation.path.split("/")[2];
  const world = (isDemo(id) ? demos : savedWorlds)?.find(item => item.id === id);
  if (world) {
    document.title = `${world.name} · TaleSide`;
    worldScreen.show(world, pending.get(id));
  } else {
    document.title = "Worlds · TaleSide";
    let message = "This World could not be found.";
    if (!isDemo(id) && savedWorlds === null) {
      message = connectionError ? "Could not connect to TaleSide." : "Loading World…";
    }
    worldScreen.unavailable(message);
  }
  showArtwork(world?.wide ?? null);
}

function updateViews() {
  updateHome();
  if (document.body.dataset.view === "world" && navigation.path.startsWith("/worlds/")) {
    updateWorld();
    updateHeader();
  }
}

function refreshWorlds(force = false) {
  if (worldRequest && !force) return worldRequest;
  const number = ++requestNumber;
  worldRequest = request("/api/worlds").then(worlds => {
    if (number !== requestNumber) return;
    savedWorlds = worlds;
    if (connectionError) showHomeMessage("");
    connectionError = false;
    updateViews();
  }).catch(() => {
    if (number !== requestNumber) return;
    connectionError = true;
    showHomeMessage("Could not connect to TaleSide.");
    if (document.body.dataset.view === "world" && navigation.path.startsWith("/worlds/")) updateWorld();
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
    updateViews();
    if (action === "pause") setTimeout(() => {
      world.status = "paused";
      updateDemoProgress(world);
      if (demos.includes(world)) updateViews();
    }, 650);
    return;
  }

  pending.set(id, action);
  updateViews();
  try {
    await request(`/api/worlds/${id}/${action}`, { method: "POST" });
    if (navigation.path === "/") showHomeMessage("");
    if (navigation.path === `/worlds/${id}`) worldScreen.setActionError("");
  } catch (error) {
    if (error.status !== 409) {
      if (navigation.path === "/") showHomeMessage(error.message);
      if (navigation.path === `/worlds/${id}`) worldScreen.setActionError(error.message);
    }
  } finally {
    await refreshWorlds(true);
    pending.delete(id);
    updateViews();
  }
}

async function rename(world, name) {
  if (isDemo(world.id)) {
    world.name = name;
  } else {
    await request(`/api/worlds/${world.id}/rename`, { method: "POST", json: { name } });
    const saved = savedWorlds?.find(item => item.id === world.id);
    if (saved) saved.name = name;
    refreshWorlds(true);
  }
  updateViews();
}

async function discard(world) {
  if (isDemo(world.id)) {
    demos = demos.filter(item => item.id !== world.id);
  } else {
    await request(`/api/worlds/${world.id}/discard`, { method: "POST" });
    savedWorlds = savedWorlds?.filter(item => item.id !== world.id) ?? null;
    refreshWorlds(true);
  }
  if (navigation.path === `/worlds/${world.id}`) navigation.replace("/");
  else updateViews();
}

function onCreated(world) {
  savedWorlds = [...(savedWorlds ?? []).filter(item => item.id !== world.id), world];
  mode.value = "saved";
  selectWorld(world);
  navigation.replace("/", {
    afterDisplay: () => revealHomeCard(world.id),
  });
  refreshWorlds(true);
}

function display(path, previous) {
  if (previous && previous !== "/") worldScreen.close();
  const view = path === "/" ? "home" : path === "/create" ? "create" : "world";
  expandedHeight = 0;
  worldTop.style.setProperty("--collapse", "0");
  worldTopSpacer.style.height = "0";
  document.body.dataset.view = view;
  home.hidden = preview.hidden = view !== "home";
  studio.hidden = view === "home";
  studio.dataset.status = "";
  worldsLink.removeAttribute("aria-current");
  createLink.removeAttribute("aria-current");
  if (view === "home") {
    document.title = "TaleSide";
    worldsLink.setAttribute("aria-current", "page");
    updateHome();
  } else if (view === "create") {
    document.title = "Create · TaleSide";
    createLink.setAttribute("aria-current", "page");
    worldScreen.create();
    showArtwork(null);
  } else {
    updateWorld();
  }
  window.scrollTo(0, 0);
  updateHeader();

  if (previous === "/") {
    studio.focus({ preventScroll: true });
  } else if (previous && path === "/") {
    const id = previous.split("/")[2];
    if (id && (isDemo(id) ? mode.value === "demo" : mode.value === "saved")) {
      revealHomeCard(id);
    } else {
      worldsLink.focus({ preventScroll: true });
    }
  }
}

function updateHeader() {
  const y = studio.hidden ? 0 : window.scrollY;
  header.classList.toggle("compact", y > 0);
  document.body.style.setProperty("--world-scroll-dim", String(Math.min(y / 360, 1) * .44));
  if (studio.hidden || worldTop.offsetHeight === 0) return;
  if (expandedHeight === 0) expandedHeight = worldTop.offsetHeight;
  const distance = Math.max(120, expandedHeight - 194);
  const collapse = Math.min(y / distance, 1);
  worldTop.style.setProperty("--collapse", String(collapse));
  if (y === 0 && !worldTop.hasAttribute("data-expanding")) expandedHeight = worldTop.offsetHeight;
  worldTopSpacer.style.height = y ? `${Math.max(0, expandedHeight - worldTop.offsetHeight)}px` : "0";
  canopy.style.setProperty("--canopy-end", `${Math.max(header.getBoundingClientRect().bottom, worldTop.getBoundingClientRect().bottom)}px`);
  canopy.style.setProperty("--canopy-opacity", String(Math.min(y / 18, 1)));
  const fade = 16 + 16 * Math.max(0, (collapse - .72) / .28);
  canopy.style.setProperty("--canopy-fade", `${fade}px`);
}

mode.addEventListener("change", () => {
  if (mode.value === "demo") {
    demos = createDemoWorlds().map(updateDemoProgress);
    for (const world of demos) new Image().src = world.wide;
  }
  resetHomeSelection();
  updateHome();
});
window.addEventListener("scroll", updateHeader, { passive: true });
window.addEventListener("resize", () => {
  expandedHeight = 0;
  worldTop.style.setProperty("--collapse", "0");
  updateHeader();
});
for (const type of ["dragover", "drop"]) {
  studio.addEventListener(type, event => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
}

if (navigation.path.startsWith("/worlds/demo-")) {
  mode.value = "demo";
  selectWorld(demos.find(world => world.id === navigation.path.split("/")[2]));
}
studio.tabIndex = -1;
display(navigation.path);
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
  updateViews();
}, 1400);
