import { firstHomeWorld, homeCover } from "./home/home.js";

const home = document.getElementById("home");
const studio = document.getElementById("studio");
const preview = document.querySelector(".preview-controls");
const studioCover = studio.querySelector(".world-cover");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

export function initNavigation({ display, confirmLeave, isDirty }) {
  let current = { path: location.pathname, index: 0 };
  let pendingTraversal = null;
  let confirmedIndex = null;
  let confirming = false;
  let transition = null;
  let createCoverId;

  history.replaceState({ index: current.index }, "");
  history.scrollRestoration = "manual";

  function commit(path, { replace = false, afterDisplay, arrivingWorld } = {}) {
    const index = current.index + (replace ? 0 : 1);
    history[replace ? "replaceState" : "pushState"]({ index }, "", path);
    enter({ index, path }, afterDisplay, arrivingWorld);
  }

  function enter(entry, afterDisplay, arrivingWorld) {
    const previous = current.path;
    const fromHome = previous === "/";
    const toHome = entry.path === "/";
    const fromCreate = previous === "/create";
    const toCreate = entry.path === "/create";
    if (fromHome && toCreate) createCoverId = firstHomeWorld();
    current = entry;
    function fadeIn(duration) {
      const targets = toHome ? [home, preview] : [studio];
      for (const element of targets) {
        element.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration, easing: "cubic-bezier(.22, 1, .36, 1)",
        });
      }
    }

    function update() {
      if (current !== entry) return;
      display(entry.path, previous);
      afterDisplay?.();
    }

    const worldPath = fromHome ? entry.path : previous;
    const createCardId = homeCover(createCoverId) ? createCoverId : firstHomeWorld();
    const cardId = arrivingWorld ?? ((fromCreate || toCreate) ? createCardId : worldPath.split("/")[2]);
    const cardCover = homeCover(cardId);
    const betweenStudios = !fromHome && !toHome && (fromCreate || toCreate);
    const canPairCovers = betweenStudios || cardCover || arrivingWorld;
    if (previous === entry.path || !canPairCovers || !document.startViewTransition || reducedMotion.matches || transition) {
      transition?.skipTransition();
      update();
      if (previous !== entry.path && (fromCreate || toCreate) && !reducedMotion.matches) {
        fadeIn(180);
      }
      return;
    }
    const markedCovers = new Set();
    function markCover(cover) {
      if (!cover) return;
      cover.style.viewTransitionName = "world-cover";
      markedCovers.add(cover);
    }
    const outgoing = fromHome ? home : studio;
    outgoing.style.viewTransitionName = "outgoing-content";
    if (fromHome) preview.style.viewTransitionName = "outgoing-shelf-controls";
    function releaseOutgoing() {
      outgoing.style.viewTransitionName = "";
      if (fromHome) preview.style.viewTransitionName = "";
    }
    document.documentElement.dataset.routeTransition = "";
    markCover(studioCover);
    markCover(cardCover);
    transition = document.startViewTransition(() => {
      // Only the outgoing view is a snapshot so the live page can receive input during its fade.
      releaseOutgoing();
      update();
      if (toHome) markCover(homeCover(cardId));
    });
    transition.ready.then(() => {
      if (current === entry) fadeIn(240);
    }).catch(() => {});
    transition.finished.catch(() => {}).finally(() => {
      releaseOutgoing();
      for (const cover of markedCovers) cover.style.viewTransitionName = "";
      delete document.documentElement.dataset.routeTransition;
      transition = null;
    });
  }

  async function navigate(path) {
    if (path === current.path || confirming) return;
    confirming = true;
    try {
      if (await confirmLeave()) commit(path);
    } finally {
      confirming = false;
    }
  }

  document.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest("a[href]");
    if (!link || link.origin !== location.origin || link.target) return;
    if (link.pathname !== "/" && link.pathname !== "/create" && !link.pathname.startsWith("/worlds/")) return;
    event.preventDefault();
    navigate(link.pathname);
  });

  async function confirmTraversal(entry, distance) {
    if (confirming) return;
    confirming = true;
    try {
      if (await confirmLeave()) {
        confirmedIndex = entry.index;
        history.go(distance);
      }
    } finally {
      confirming = false;
    }
  }

  window.addEventListener("popstate", event => {
    const entry = { index: event.state?.index, path: location.pathname };
    if (entry.index === current.index) {
      const traversal = pendingTraversal;
      pendingTraversal = null;
      if (traversal) confirmTraversal(traversal.entry, traversal.distance);
      return;
    }
    if (entry.index === confirmedIndex || !isDirty()) {
      confirmedIndex = null;
      enter(entry);
      return;
    }

    // Back has already moved the URL. Restore Create before asking, then replay only on confirmation.
    const distance = entry.index - current.index;
    if (pendingTraversal) return;
    pendingTraversal = { entry, distance };
    history.go(-distance);
  });

  return {
    get path() { return current.path; },
    replace(path, options) { commit(path, { ...options, replace: true }); },
  };
}
