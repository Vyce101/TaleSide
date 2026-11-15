import { showArtwork } from "../artwork.js";
import { createCard, updateCard } from "./world-card.js";

const home = document.querySelector("#home");
const empty = document.querySelector("#empty");
const chooser = document.querySelector("#chooser");
const cards = document.querySelector("#worlds");
const enter = document.querySelector("#enter");
const message = document.querySelector("#message");

let previewed = null;
const displayed = new Map();

export function selectWorld(world) {
  previewed = world?.id ?? null;
  enter.hidden = !world;
  if (world) enter.href = `/worlds/${world.id}`;
  else enter.removeAttribute("href");
  if (!home.hidden) showArtwork(world?.wide ?? null);
}

export function renderHome(worlds, loading, pending, onJobChange) {
  empty.hidden = loading || worlds.length > 0;
  chooser.hidden = !worlds.length;
  const ids = new Set(worlds.map(world => world.id));
  for (const [id, card] of displayed) {
    if (!ids.has(id)) {
      card.node.remove();
      displayed.delete(id);
    }
  }
  worlds.forEach((world, index) => {
    if (!displayed.has(world.id)) displayed.set(world.id, createCard(world, selectWorld, onJobChange));
    const card = displayed.get(world.id);
    updateCard(card, world, pending.get(world.id));
    if (cards.children[index] !== card.node) cards.insertBefore(card.node, cards.children[index] ?? null);
  });
  selectWorld(worlds.find(world => world.id === previewed));
}

export function showHomeMessage(text) {
  message.textContent = text;
  message.hidden = !text;
}

export function revealHomeCard(id) {
  displayed.get(id)?.hit.focus({ preventScroll: true });
  displayed.get(id)?.node.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function resetHomeSelection() {
  selectWorld(null);
  cards.scrollLeft = 0;
}

home.addEventListener("dragstart", event => event.preventDefault());

cards.addEventListener("wheel", event => {
  if (cards.scrollWidth <= cards.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  event.preventDefault();
  cards.scrollLeft += event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1);
}, { passive: false });
