const fallbackCover = "/assets/defaults/Default%20Cover.png";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function cover(world, layer) {
  const node = element("div", `cover ${layer}${world.cover ? "" : " fallback"}`);
  const image = element("img");
  image.alt = "";
  image.src = world.cover ?? fallbackCover;
  if (world.cover) {
    image.addEventListener("error", () => {
      node.classList.add("fallback");
      image.src = fallbackCover;
      node.append(element("span", "cover-name", node.dataset.name));
    }, { once: true });
  }
  node.append(image);
  node.dataset.name = world.name;
  if (!world.cover) node.append(element("span", "cover-name", world.name));
  return node;
}

export function createCard(world, onPreview, onJobChange) {
  const node = element("article", "card");
  node.dataset.world = world.id;
  const visuals = element("div", "card-visual");
  visuals.setAttribute("aria-hidden", "true");
  visuals.append(cover(world, "cover-base"), cover(world, "cover-progress"), element("div", "alert-tint"));
  const hit = element("a", "card-hit");
  hit.href = `/worlds/${world.id}`;
  const info = element("div", "card-info");
  const name = element("div", "card-title", world.name);
  const action = element("button", "operation");
  action.type = "button";
  const icon = element("span", "operation-icon");
  icon.setAttribute("aria-hidden", "true");
  const label = element("span");
  action.append(icon, label);
  info.append(name, action);
  node.append(visuals, hit, info);

  const card = { node, hit, name, action, icon, label, world };
  const activate = () => {
    if (card.world.status === "failed") node.classList.remove("alert");
    onPreview(card.world);
  };
  node.addEventListener("pointerenter", activate);
  node.addEventListener("focusin", activate);
  hit.addEventListener("click", activate);
  action.addEventListener("click", () => onJobChange(card));
  return card;
}

export function updateCard(card, world, pending) {
  const { node, hit, name, action, icon, label } = card;
  if (world.status === "failed" && node.dataset.status !== "failed") {
    node.classList.toggle("alert", !node.matches(":hover, :has(:focus-visible)"));
  } else if (world.status !== "failed") {
    node.classList.remove("alert");
  }
  if (name.textContent !== world.name) {
    name.textContent = world.name;
    node.querySelectorAll(".cover").forEach(cover => {
      cover.dataset.name = world.name;
      const title = cover.querySelector("span");
      if (title) title.textContent = world.name;
    });
  }
  card.world = world;
  node.dataset.status = world.status;
  node.style.setProperty("--progress", `${world.progress}%`);
  hit.setAttribute("aria-label", `Open ${world.name}`);
  action.hidden = world.status === "ready";
  const pausing = world.status === "pausing" || pending === "pause";
  action.disabled = Boolean(pending) || pausing;
  if (action.hidden && document.activeElement === action) hit.focus({ preventScroll: true });
  const creating = world.status === "creating";
  icon.className = `operation-icon ${creating || pausing ? "pause" : "play"}`;
  const status = pausing ? "Pausing…" : world.status[0].toUpperCase() + world.status.slice(1);
  label.textContent = `${status} ${world.progress}%`;
  action.setAttribute("aria-label", pausing ? `Pausing ${world.name}`
    : `${creating ? "Pause" : "Resume"} ${world.name}. ${label.textContent}`);
  action.title = world.error ?? "";
}
