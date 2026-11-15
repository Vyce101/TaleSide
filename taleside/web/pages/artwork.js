const hero = document.querySelector("#hero-art");

let artworkRequest = 0;
let artworkUrl = null;

export async function showArtwork(url) {
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
  if (url) {
    document.body.style.setProperty("--studio-backdrop", `url(${JSON.stringify(url)})`);
  } else {
    document.body.style.removeProperty("--studio-backdrop");
  }
  if (!next) {
    hero.classList.add("outgoing");
    const fade = hero.getAnimations().find(animation => animation.animationName === "hide-hero");
    if (!fade) hero.replaceChildren();
    fade?.finished.then(() => {
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
