import type { Message, Tale, TaleSearchResult, World } from "../shared/types.js";
import { worlds } from "./data.js";
import { renderMarkdown, tintDialogue } from "./markdown.js";

const iconPaths = {
  settings: '<path d="M3 5h3m7 0h8M3 12h9m7 0h2M3 19h2m7 0h9"/><circle class="solid" cx="9.5" cy="5" r="2.6"/><circle class="solid" cx="15.5" cy="12" r="2.6"/><circle class="solid" cx="8.5" cy="19" r="2.6"/>',
  key: '<path class="solid" fill-rule="evenodd" d="M7.6 5.7a6.3 6.3 0 1 0 5.5 9.4h2.3l1.4-1.4 1.5 1.4 1.4-1.4 1.1.8 1.7-1.7v-3.1h-9.4a6.3 6.3 0 0 0-5.5-4Zm-1.4 4.2a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2Z"/>',
  worlds: '<circle class="solid" cx="12.3" cy="11.8" r="7.1"/><ellipse cx="12" cy="12" rx="10.1" ry="3.5" transform="rotate(-30 12 12)" stroke-width="1.7"/><circle class="solid" cx="20.1" cy="4.4" r="1.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="m11 5-7 7 7 7m-7-7h16"/>',
  tales: '<path class="solid" d="M3.8 3.5h11a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-2.5 2.5H8l-4.7 3.2v-3.3A2.5 2.5 0 0 1 1.3 12V6a2.5 2.5 0 0 1 2.5-2.5Zm15 4h1.3a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-2.1 2.5v2.8l-4-2.7H12a2.5 2.5 0 0 1-2.3-1.6h5a4 4 0 0 0 4-4.1Z"/>',
  rename: '<path class="solid" d="m15.4 3.5 5.1 5.1-10.9 11-6.1.9.9-6.1L15.4 3.5Zm1.3-1.3.8-.8a2 2 0 0 1 2.8 0l2.3 2.3a2 2 0 0 1 0 2.8l-.8.8Z"/>',
  delete: '<path class="solid" fill-rule="evenodd" d="M4 5h5V2h6v3h5v2H4V5Zm2 4h12l-.8 11.4a1.6 1.6 0 0 1-1.6 1.6H8.4a1.6 1.6 0 0 1-1.6-1.6L6 9Zm3 2v8h1.5v-8H9Zm4.5 0v8H15v-8h-1.5Z"/>',
  deleteWorld: '<path d="M13 18.5a8 8 0 1 1 5.7-5.7M3 11h16M11 3a12 12 0 0 0 0 16m0-16a12 12 0 0 1 2.7 10M16 16l5 5m0-5-5 5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  pin: '<path d="m14 3 7 7-4 1-3 3-1 4-7-7 4-1 3-3 1-4Z"/><path d="m9 15-6 6"/>',
  send: '<path class="solid" d="M21 3 2.8 10.2a1 1 0 0 0 .1 1.9l6.2 1.6 8-7.3-6.1 9.2 1.2 5.6a1 1 0 0 0 1.9.2L22 4.4A1 1 0 0 0 21 3Z"/>',
  stop: '<rect class="solid" x="5" y="5" width="14" height="14" rx="2"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  pause: '<rect class="solid" x="5" y="4" width="5" height="16" rx="1"/><rect class="solid" x="14" y="4" width="5" height="16" rx="1"/>',
  play: '<path class="solid" d="M6 4a1 1 0 0 1 1.5-.8l14 8a1 1 0 0 1 0 1.6l-14 8A1 1 0 0 1 6 20Z"/>',
  replace: '<path d="M4 10a8 8 0 0 1 14-3m2 7a8 8 0 0 1-14 3"/><path class="solid" d="M20.5 3.7v6.6h-6.6ZM3.5 20.3v-6.6h6.6Z"/>',
  gear: '<path class="solid" fill-rule="evenodd" d="m10 2-1 3-2 .8-2.8-1.1-2 2.6 1.8 2.3-.3 2.1L1 13v3l3 .6 1.2 1.7-.3 2.7 3 1.3 1.9-2.2h2.1l2.1 2.2 2.9-1.3-.3-2.8 1.3-1.7 3-.6v-3l-2.7-1.4-.3-2.1 1.8-2.3-2-2.6L15 5.7l-2-.8L12 2Zm1 6.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"/>',
  model: '<path class="solid" d="M10.5 2c1 5.1 3.1 7.4 8.5 8.5-5.4 1.1-7.5 3.4-8.5 8.5-1.1-5.1-3.4-7.4-8.5-8.5 5.1-1.1 7.4-3.4 8.5-8.5Zm8.7 12.1c.5 2.5 1.5 3.5 4 4-2.5.5-3.5 1.5-4 4-.5-2.5-1.5-3.5-4-4 2.5-.5 3.5-1.5 4-4Z"/>',
  save: '<path class="solid" fill-rule="evenodd" d="M4 2h12l5 5v13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm2 2v5h10V4H6Zm0 10v6h12v-6H6Z"/>',
  personas: '<circle cx="9" cy="7" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m2-16a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 5"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  star: '<path d="m12 3 3 6 7 .9-5 4.6 1 6.5-6-3.2L6 21l1-6.5-5-4.6L9 9Z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  drag: '<path d="M7 6h10M7 12h10M7 18h10"/>',
  duplicate: '<path d="M8 5H5v16h12v-3M9 3h10v13H9zM11 9h6m-3-3v6"/>',
} satisfies Record<string, string>;

export type Icon = keyof typeof iconPaths;

export function icon(name: Icon) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name]}</svg>`;
}

export function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function iconButton(action: string, glyph: Icon, label: string, attributes = "") {
  return `<button type="button" class="icon-button" data-action="${action}" aria-label="${label}" data-tooltip="${label}" ${attributes}>${icon(glyph)}</button>`;
}

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function formatDate(timestamp: number) {
  const date = dayFormat.formatToParts(timestamp)
    .map(part => part.type === "month" ? part.value.slice(0, 3) : part.value).join("");
  return `${date} @ ${timeFormat.format(timestamp)}`;
}

export function avatar(world?: Pick<World, "artwork">) {
  const image = world?.artwork ?? (world ? "assets/world-logo.png" : "assets/logo.png");
  const treatment = world?.artwork ? "world-portrait" : world ? "default-world-art" : "default-art";
  return `<span class="avatar ${treatment}"><img src="${escapeHtml(image)}" alt="" width="42" height="42"></span>`;
}

export function searchInput(id: string, label: string) {
  return `<input type="search" id="${id}" class="list-search" aria-label="${label}" placeholder="${label}" maxlength="512" autocomplete="off">`;
}

export function worldRows(entries: World[], active: World | undefined, searching: boolean) {
  if (!entries.length && searching) return '<li class="empty-copy">No matching Worlds</li>';
  return entries.map(world => {
    const name = escapeHtml(world.name);
    const hasJob = ["creating", "pausing", "paused", "failed"].includes(world.status);
    return `<li><button class="world-row" type="button" data-action="open-world" data-id="${world.id}" data-tooltip="${name}"
      ${world.id === active?.id ? 'aria-current="true"' : ''}>
      ${avatar(world)}<span class="world-name">${name}</span>
      <progress max="100" value="${world.progress}" aria-label="${name} indexing" ${hasJob ? "" : "hidden"}></progress>
      <span class="progress-text" ${world.status === "ready" ? "hidden" : ""}>${escapeHtml(worldIndexStatus(world))}</span>
    </button></li>`;
  }).join("");
}

export function taleRows(entries: TaleSearchResult[], currentId?: string) {
  return `<ul class="tale-list">${entries.map(tale => {
    const world = worlds.find(entry => entry.id === tale.world_id);
    const count = tale.message_count;
    const preview = tale.content.replace(/\s+/g, " ").slice(0, 320) || "No messages yet";
    const highlighted = tale.match?.map(({ text, highlighted }) => highlighted
      ? `<mark>${escapeHtml(text)}</mark>` : escapeHtml(text)).join("");
    const name = escapeHtml(tale.title);
    const id = `data-id="${tale.id}"`;
    return `<li class="tale-row"${currentId === tale.id ? ' data-current' : ''}>
      <div class="tale-art">${avatar(world)}</div>
      <button type="button" class="tale-link" data-action="open-tale" ${id} aria-label="Open ${name}"
        aria-describedby="preview-${tale.id}" ${currentId === tale.id ? 'aria-current="true"' : ''}>
        <strong class="tale-name">${name}</strong>
      </button>
      <time class="tale-stamp" datetime="${new Date((tale.last_activity_at ?? tale.created_at) * 1000).toISOString()}">${formatDate((tale.last_activity_at ?? tale.created_at) * 1000)}</time>
      <div class="tale-row-actions">
        ${iconButton("pin-tale", "pin", tale.pinned ? "Unpin" : "Pin", `${id} aria-pressed="${tale.pinned}"`)}
        ${iconButton("rename-tale", "rename", `Rename ${name}`, id)}
        ${iconButton("delete-tale", "delete", `Delete ${name}`, id)}
      </div>
      <p class="tale-preview" id="preview-${tale.id}">${highlighted ?? escapeHtml(preview)}</p>
      <span class="tale-count">${count} ${count === 1 ? "message" : "messages"}</span>
    </li>`;
  }).join("")}</ul>`;
}

export const recentCollapsed = 5;
const recentExpanded = 10;

export function recentTaleRows(entries: TaleSearchResult[], expanded: boolean, searching: boolean) {
  if (!entries.length) return searching ? '<p class="empty-copy">No matching Tales</p>'
    : '<p class="empty-copy">Open Worlds to start a Tale.</p>';
  return taleRows(searching ? entries : entries.slice(0, expanded ? recentExpanded : recentCollapsed));
}

export function homeView(entries: TaleSearchResult[], expanded: boolean) {
  return `<section class="home-view" aria-labelledby="screen-title">
    <div class="welcome-card">
      <div class="home-heading">
        <img src="assets/logo.png" width="31" height="31" alt="">
        <h1 id="screen-title" tabindex="-1">TaleSide</h1>
      </div>
      <div class="search-heading recent-heading">
        <h2 id="recent-tales-title">Recent Tales</h2>
        ${searchInput("home-tale-search", "Search Tales")}
      </div>
      <div id="recent-tales" aria-labelledby="recent-tales-title">
        ${recentTaleRows(entries, expanded, false)}
      </div>
      <button class="icon-button show-more" type="button" data-action="expand-recent" ${entries.length > recentCollapsed ? "" : "hidden"}
        aria-label="${expanded ? "Show fewer" : "Show more Tales"}" data-tooltip="${expanded ? "Show fewer" : "Show more Tales"}"
        aria-controls="recent-tales" aria-expanded="${expanded}">${icon("down")}</button>
    </div>
  </section>`;
}

function composerView() {
  return `<form class="composer" id="composer" autocomplete="off">
    <textarea id="message-input" aria-label="Message" placeholder="Type a message" rows="1"></textarea>
    <span class="composer-placeholder" aria-hidden="true">Type a message</span>
    <button type="submit" class="primary-button send-button" id="send-message" aria-label="Send message" data-tooltip="Send message">${icon("send")}</button>
  </form>`;
}

export function idleView(content: string) {
  return `<div class="tale-view">
    <div class="tale-header idle-header">${icon("tales")}<span>No Tale open</span></div>
    ${content}
  </div>`;
}

export function taleView(tale: Tale, world: World) {
  return `<div class="tale-view">
    <header class="tale-header">
      <h1 id="screen-title" tabindex="-1" data-tooltip="${escapeHtml(tale.title)}">${escapeHtml(tale.title)}</h1>
      <div class="tale-actions" aria-label="Tale actions" role="group">
        ${iconButton("toggle-history", "tales", "View Tales", 'aria-expanded="false" aria-controls="tale-history"')}
        ${iconButton("new-tale", "plus", "New Tale", world.can_play ? "" : "disabled")}
        ${iconButton("rename-tale", "rename", "Rename Tale", `data-id="${tale.id}"`)}
        ${iconButton("delete-tale", "delete", "Delete Tale", `data-id="${tale.id}"`)}
        ${iconButton("close-tale", "close", "Close Tale")}
      </div>
    </header>
    <section id="tale-history" class="tale-history" aria-labelledby="history-title" hidden>
      <div class="history-heading search-heading">
        <h2 id="history-title">Tales</h2>
        ${searchInput("world-tale-search", "Search Tales")}
      </div>
      <div id="history-list" class="history-list" role="region" aria-label="Tales list" tabindex="0"></div>
    </section>
    <div class="transcript" id="transcript" role="region" aria-label="Transcript" tabindex="0">
      <div id="messages" class="messages"></div>
    </div>
    ${composerView()}
  </div>`;
}

export function worldIndexStatus(world: World) {
  const progress = `${Math.floor(world.progress)}%`;
  switch (world.status) {
    case "ready": return "Indexed";
    case "unindexed": return "Unindexed";
    case "failed": return world.error ? `Failed · ${world.error}` : "Failed";
    case "paused": return `Paused · ${progress}`;
    case "pausing": return `Pausing · ${progress}`;
    default: return `Indexing · ${progress}`;
  }
}

export function messageTurn(message: Message, world: World, last = false, canRegenerate = false, busy = false, draft = false) {
  const player = message.role === "user";
  const thinking = message.status === "generating" && !message.content;
  const role = player ? "player" : "narrator";
  const model = escapeHtml(message.model ?? "");
  const time = message.elapsed_ms === null ? (message.status === "generating" ? "0s" : "") : formatDuration(message.elapsed_ms);
  const count = message.swipes?.length ?? 1;
  const position = message.swipe ?? 0;
  const pendingActions = draft || message.id < 0;
  const disabled = busy ? "disabled" : "";
  const actions = `<div class="turn-actions" ${pendingActions ? "inert" : ""}>
    ${canRegenerate ? iconButton("regenerate-turn", "replace", "Regenerate", disabled) : ""}
    ${iconButton("edit-turn", "rename", "Edit", disabled)}
  </div>`;
  const swipable = last && !player && (message.opening ? count > 1 : canRegenerate);
  const previous = swipable ? iconButton("previous-swipe", "left", "Previous swipe",
    !message.opening && position === 0 ? "hidden" : busy ? "disabled" : "") : "";
  const next = swipable ? `<div class="swipe-right">
    ${iconButton("next-swipe", "right", !message.opening && position === count - 1 ? "New swipe" : "Next swipe", disabled)}
    <span class="swipe-counter">${position + 1}/${count}</span>
  </div>` : "";
  return `<article class="turn ${role}" data-message="${message.id}" ${last ? "data-final" : ""} ${swipable ? "data-swipable" : ""}>
    <div class="turn-rail">
      ${avatar(player ? message.player_name ? { artwork: message.player_artwork ?? null } : undefined : world)}
      ${time ? `<span class="reply-time" data-tooltip="Time to finished response">${time}</span>` : ""}
    </div>
    <div class="turn-content">
      <header>
        <strong>${player ? escapeHtml(message.player_name ?? "You") : escapeHtml(world.name)}</strong>
        ${model ? `<span class="model-badge" role="img" tabindex="0" aria-label="Model: ${model}" data-tooltip="${model}">${icon("model")}</span>` : ""}
        ${actions}
      </header>
      ${message.thinking ? thinkingView(message, thinking) : ""}
      <div class="prose"></div>
    </div>
    ${previous}
    ${next}
  </article>`;
}

export function messageRows(messages: Message[], world: World, busy = false, draft = false) {
  const hasUser = messages.some(message => message.role === "user");
  return messages.length ? messages.map((message, index) => {
    const last = index === messages.length - 1;
    return messageTurn(message, world, last, last && (message.role === "user" || (hasUser && !message.opening)), busy, draft);
  }).join("") : '<p class="empty-copy">Write the first message to begin this Tale.</p>';
}

export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes ? `${minutes}m${remaining ? remaining + "s" : ""}` : `${seconds}s`;
}

function thinkingView(message: Message, thinking: boolean) {
  const label = thinking ? '<span>Thinking<span class="thinking-dots">...</span></span>' : message.thinking_ms
    ? "Thought for " + formatDuration(message.thinking_ms) : "Thoughts";
  return `<details class="thinking-block" data-thought-for="${message.id}">
    <summary>${label}${icon("down")}</summary><div class="thought-prose"></div>
  </details>`;
}

export function fillMessageText(container: ParentNode, messages: Message[]) {
  for (const message of messages) {
    const article = container.querySelector(`[data-message="${message.id}"]`);
    if (!article) continue;
    const prose = article.querySelector(".prose")!;
    if (message.role === "assistant") renderMarkdown(prose, message.content, true);
    else {
      for (const paragraph of message.content.split(/\n\s*\n/)) {
        const node = document.createElement("p");
        node.textContent = paragraph;
        prose.append(node);
      }
      tintDialogue(prose);
    }
    const thought = article.querySelector(".thought-prose");
    if (thought) renderMarkdown(thought, message.thinking);
    article.querySelectorAll<HTMLElement>(".prose > *, .thought-prose > *").forEach((block, index) => {
      block.dataset.passage = `${message.id}-${index}`;
    });
  }
}
