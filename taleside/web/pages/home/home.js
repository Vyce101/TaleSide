import { createCard, updateCard } from "./world-card.js";

const empty = document.querySelector("#empty");
const chooser = document.querySelector("#chooser");
const cards = document.querySelector("#worlds");
const enter = document.querySelector("#enter");
const message = document.querySelector("#message");

let savedWorlds = [];
let previewed = null;
let refreshRequest = 0;
const displayed = new Map();
const pending = new Set();

function showPreview(world) {
  previewed = world?.id ?? null;
  enter.hidden = !world;
}

function render() {
  const worlds = savedWorlds;
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
    render();
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

cards.addEventListener("wheel", event => {
  if (cards.scrollWidth <= cards.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  event.preventDefault();
  cards.scrollLeft += event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1);
}, { passive: false });

render();
refreshWorlds();
setInterval(refreshWorlds, 1200);
