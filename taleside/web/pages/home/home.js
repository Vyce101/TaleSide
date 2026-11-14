import { createDemoWorlds } from "./demo-worlds.js";
import { createCard, updateCard } from "./world-card.js";

const empty = document.querySelector("#empty");
const chooser = document.querySelector("#chooser");
const cards = document.querySelector("#worlds");
const hero = document.querySelector("#hero-art");
const enter = document.querySelector("#enter");
const message = document.querySelector("#message");
const previewMode = document.querySelector("#world-preview-mode");

let savedWorlds = [];
let demoWorlds = [];
let previewed = null;
let artworkRequest = 0;
let artworkUrl = null;
let refreshRequest = 0;
const displayed = new Map();
const pending = new Set();

async function showArtwork(url) {
  if (url === artworkUrl) return;
  artworkUrl = url;
  const request = ++artworkRequest;
  const next = url ? new Image() : null;
  if (next) {
    next.src = url;
    next.alt = "";
    try {
      await next.decode();
    } catch {
      if (request === artworkRequest) showArtwork(null);
      return;
    }
  }
  if (request !== artworkRequest) return;
  if (!next) {
    hero.classList.add("outgoing");
    hero.getAnimations()[0]?.finished.then(() => {
      if (request === artworkRequest) hero.replaceChildren();
    }).catch(() => {});
    return;
  }
  hero.classList.remove("outgoing");
  const frame = document.createElement("div");
  frame.className = "hero-frame incoming";
  frame.append(next);
  hero.append(frame);
  frame.addEventListener("animationend", () => {
    if (hero.lastElementChild === frame) {
      while (hero.firstElementChild !== frame) hero.firstElementChild.remove();
    }
  }, { once: true });
}

function showPreview(world) {
  previewed = world?.id ?? null;
  enter.hidden = !world;
  showArtwork(world?.wide ?? null);
}

function render() {
  const worlds = { saved: savedWorlds, demo: demoWorlds, empty: [] }[previewMode.value];
  empty.hidden = worlds.length > 0;
  chooser.hidden = !worlds.length;
  const ids = new Set(worlds.map(world => world.id));
  for (const [id, card] of displayed) {
    if (!ids.has(id)) {
      card.node.remove();
      displayed.delete(id);
    }
  }
  worlds.forEach((world, index) => {
    if (!displayed.has(world.id)) displayed.set(world.id, createCard(world, showPreview, changeJob));
    const card = displayed.get(world.id);
    updateCard(card, world, pending.has(world.id));
    if (cards.children[index] !== card.node) cards.insertBefore(card.node, cards.children[index] ?? null);
  });
  showPreview(worlds.find(world => world.id === previewed));
}

function showMessage(text) {
  message.textContent = text;
  message.hidden = !text;
}

async function refreshWorlds() {
  const request = ++refreshRequest;
  try {
    const response = await fetch("/api/worlds", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const worlds = await response.json();
    if (request !== refreshRequest) return;
    savedWorlds = worlds;
    if (previewMode.value === "saved") render();
    if (message.dataset.connection) showMessage("");
    delete message.dataset.connection;
  } catch {
    if (request !== refreshRequest) return;
    message.dataset.connection = "true";
    showMessage("Could not connect to TaleSide.");
  }
}

async function changeJob(card) {
  const { id, status } = card.world;
  if (status === "ready" || pending.has(id)) return;
  const action = status === "creating" ? "pause" : "resume";
  if (previewMode.value === "demo") {
    card.world.status = action === "pause" ? "paused" : "creating";
    render();
    return;
  }
  pending.add(id);
  card.action.setAttribute("aria-disabled", "true");
  try {
    const response = await fetch(`/api/worlds/${id}/${action}`, { method: "POST" });
    if (!response.ok && response.status !== 409) throw new Error();
    showMessage("");
    await refreshWorlds();
  } catch {
    showMessage(`Could not ${action} ${card.world.name}.`);
  } finally {
    pending.delete(id);
    render();
  }
}

document.addEventListener("dragstart", event => event.preventDefault());

previewMode.addEventListener("change", () => {
  if (previewMode.value === "demo") {
    demoWorlds = createDemoWorlds();
    demoWorlds.forEach(world => {
      const image = new Image();
      image.src = world.wide;
    });
  }
  showPreview(null);
  render();
  cards.scrollLeft = 0;
});

cards.addEventListener("wheel", event => {
  if (cards.scrollWidth <= cards.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  event.preventDefault();
  cards.scrollLeft += event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1);
}, { passive: false });

render();
refreshWorlds();
setInterval(refreshWorlds, 1200);
setInterval(() => {
  if (previewMode.value !== "demo") return;
  const creating = demoWorlds.filter(world => world.status === "creating");
  if (!creating.length) return;
  creating.forEach(world => {
    world.progress = Math.min(100, world.progress + 1);
    if (world.progress === 100) world.status = "ready";
  });
  render();
}, 1400);
