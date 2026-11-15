import { initBooksPanel } from "./books-panel.js";
import { createWorldImport } from "./import.js";

const element = id => document.getElementById(id);
const content = element("world-content");
const access = element("world-access");
const studio = element("studio");
const cover = studio.querySelector(".world-cover");
const coverImage = cover.querySelector("img");
const defaultCover = coverImage.getAttribute("src");
const worldName = element("world-name");
const maxSize = element("max-chunk-size");
const boundary = element("boundary-distance");
const action = element("world-action");
const actionLabel = element("world-action-label");
const profile = element("embedding-profile");
const profileMenu = element("profile-menu");
const profileOption = element("profile-option");
const dialog = element("studio-dialog");
const tabs = [...studio.querySelectorAll('[role="tab"]')];
const worldTop = element("world-top");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function setError(id, text) {
  const error = element(id);
  error.textContent = text;
  error.hidden = !text;
}

function showTab(id) {
  for (const tab of tabs) {
    const selected = tab.id === `${id}-tab`;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    element(tab.getAttribute("aria-controls")).hidden = !selected;
  }
}

function setProfileMenu(open, focus = false) {
  profileMenu.hidden = !open;
  profile.setAttribute("aria-expanded", String(open));
  if (focus) (open ? profileOption : profile).focus();
}

let expandTimer;

function selectTab(id) {
  const tab = element(`${id}-tab`);
  if (tab.getAttribute("aria-selected") === "true") return;
  setProfileMenu(false);
  if (window.scrollY > 4 && !reducedMotion.matches) {
    worldTop.dataset.expanding = "";
    clearTimeout(expandTimer);
    expandTimer = setTimeout(() => { delete worldTop.dataset.expanding; }, 240);
  }
  window.scrollTo({ top: 0, behavior: "instant" });
  showTab(id);
  if (!reducedMotion.matches) {
    element(tab.getAttribute("aria-controls")).animate([
      { opacity: 0, transform: "translateY(8px)" },
      { opacity: 1, transform: "translateY(0)" },
    ], { duration: 200, easing: "cubic-bezier(.22, 1, .36, 1)" });
  }
}

let answer;

function ask(title, description, cancel, confirm, danger = false) {
  element("dialog-title").textContent = title;
  element("dialog-description").textContent = description;
  element("dialog-cancel").textContent = cancel;
  const confirmButton = element("dialog-confirm");
  confirmButton.textContent = confirm;
  confirmButton.classList.toggle("danger", danger);
  dialog.returnValue = "";
  answer = new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
  dialog.showModal();
  return answer;
}

dialog.addEventListener("click", event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close("cancel");
});

profile.addEventListener("click", () => setProfileMenu(profileMenu.hidden));
profile.addEventListener("keydown", event => {
  if (event.key !== "ArrowDown" || profile.disabled) return;
  event.preventDefault();
  setProfileMenu(true, true);
});
profileOption.addEventListener("click", () => setProfileMenu(false, true));
profile.closest(".profile-picker").addEventListener("keydown", event => {
  if (event.key === "Escape" && !profileMenu.hidden) setProfileMenu(false, true);
});
document.addEventListener("pointerdown", event => {
  if (!event.target.closest(".profile-picker")) setProfileMenu(false);
});

function showMetadata(books, model, chunks) {
  element("world-book-count").textContent = `${books} ${books === 1 ? "Book" : "Books"}`;
  element("world-model").textContent = model;
  element("world-chunk-dot").hidden = chunks === undefined;
  element("world-chunk-count").hidden = chunks === undefined;
  element("world-chunk-count").textContent = chunks === undefined ? "" : `${chunks.toLocaleString()} Chunks`;
}

function validSetting(field) {
  return field.validity.valid && Number.isSafeInteger(field.valueAsNumber);
}

function showSettingFeedback(field, error, warning = "") {
  const feedback = element(`${field.id}-feedback`);
  feedback.textContent = error || warning;
  feedback.hidden = !feedback.textContent;
  field.setAttribute("aria-invalid", String(Boolean(error)));
  field.closest(".setting").dataset.feedback = error ? "error" : warning ? "warning" : "";
}

function updateSettingFeedback() {
  const sizeValid = validSetting(maxSize);
  const distanceValid = validSetting(boundary);
  const earlySplit = sizeValid && distanceValid && boundary.valueAsNumber >= maxSize.valueAsNumber;
  showSettingFeedback(maxSize, sizeValid ? "" : "Enter a whole number of at least 1 character.");
  showSettingFeedback(boundary, distanceValid ? "" : "Enter a whole number of 0 or more characters.",
    earlySplit ? "Boundary distance is at or above the maximum chunk size. Chunks may split early." : "");
}

function showCover(title, image = defaultCover) {
  const fallback = image === defaultCover;
  cover.classList.toggle("fallback", fallback);
  const text = element("cover-title");
  text.hidden = !fallback || !title;
  text.textContent = title;
  if (fallback) cover.title = title;
  else cover.removeAttribute("title");
  if (coverImage.getAttribute("src") !== image) coverImage.src = image;
}

coverImage.addEventListener("error", () => {
  if (!cover.classList.contains("fallback")) showCover(element("cover-title").textContent);
});

export function initWorldScreen({ request, onCreated }) {
  let settingUp = false;
  let savingWorld = null;
  let beforeUnload = false;
  const books = initBooksPanel(onEdit);
  const worldImport = createWorldImport({
    request,
    ask,
    onReportChange: describeSetup,
    onSaving: () => setBusy(true, "Saving World…"),
  });

  function isDirty() {
    return settingUp && (worldName.value.trim() !== "" || books.selected.length > 0
      || maxSize.value !== maxSize.defaultValue || boundary.value !== boundary.defaultValue);
  }

  function warnOnUnload(event) {
    event.preventDefault();
    event.returnValue = "";
  }

  function syncUnloadWarning() {
    const dirty = isDirty();
    if (dirty === beforeUnload) return;
    if (dirty) window.addEventListener("beforeunload", warnOnUnload);
    else window.removeEventListener("beforeunload", warnOnUnload);
    beforeUnload = dirty;
  }

  function describeSetup() {
    const count = books.selected.length;
    const chunks = count === 0 ? 0 : worldImport.chunkCount;
    showMetadata(count, "Gemini Embedding 2", chunks);
    element("books-tab").textContent = `Books (${count})`;
  }

  function onEdit() {
    worldImport.cancel();
    showCover(worldName.value.trim());
    describeSetup();
    updateSettingFeedback();
    setError("action-error", "");
    syncUnloadWarning();
  }

  function setBusy(value, label = "Checking books…") {
    action.disabled = value;
    actionLabel.textContent = value ? label : "Create";
    worldName.readOnly = value;
    maxSize.disabled = boundary.disabled = value;
    profile.disabled = value;
    element("import-note").hidden = !value;
    books.setLocked(value);
  }

  function reset(isCreate) {
    settingUp = isCreate;
    savingWorld = null;
    worldName.value = "";
    maxSize.value = maxSize.defaultValue;
    boundary.value = boundary.defaultValue;
    worldName.readOnly = !isCreate;
    maxSize.disabled = boundary.disabled = !isCreate;
    books.reset();
    element("setup-name").hidden = !isCreate;
    element("import-note").hidden = true;
    element("discard-world").hidden = isCreate;
    element("chronicles-tab").hidden = true;
    element("world-progress").hidden = true;
    element("play-world").toggleAttribute("hidden", true);
    profile.disabled = !isCreate;
    setProfileMenu(false);
    element("settings-lock").textContent = isCreate ? "Locked once creation starts" : "Locked for this World";
    setError("action-error", "");
    showSettingFeedback(maxSize, "");
    showSettingFeedback(boundary, "");
    showTab("books");
    syncUnloadWarning();
  }

  async function submit() {
    if (savingWorld) return;
    setError("action-error", "");
    if (!books.selected.length) {
      selectTab("books");
      setError("action-error", "Add at least one TXT book.");
      element("add-books").focus();
      return;
    }
    for (const field of [maxSize, boundary]) {
      if (validSetting(field)) continue;
      selectTab("settings");
      updateSettingFeedback();
      field.focus();
      return;
    }

    const settings = {
      name: worldName.value,
      max_chunk_size: maxSize.valueAsNumber,
      boundary_search_distance: boundary.valueAsNumber,
    };
    setBusy(true);
    const submission = worldImport.save(settings, books.selected);
    savingWorld = submission;
    try {
      const world = await submission;
      if (!world || savingWorld !== submission) return;
      settingUp = false;
      syncUnloadWarning();
      onCreated(world);
    } catch (error) {
      if (savingWorld === submission) setError("action-error", error.message);
    } finally {
      if (savingWorld === submission) {
        savingWorld = null;
        if (settingUp) setBusy(false);
      }
    }
  }

  action.addEventListener("click", () => {
    if (settingUp) submit();
  });
  for (const field of [worldName, maxSize, boundary]) field.addEventListener("input", onEdit);
  for (const field of [maxSize, boundary]) field.addEventListener("blur", () => {
    if (field.disabled || field.value) return;
    field.value = field.defaultValue;
    onEdit();
  });
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab.id.replace("-tab", "")));
    tab.addEventListener("keydown", event => {
      const available = tabs.filter(item => !item.hidden);
      const index = available.indexOf(tab);
      const destinations = {
        ArrowLeft: (index + available.length - 1) % available.length,
        ArrowRight: (index + 1) % available.length,
        Home: 0,
        End: available.length - 1,
      };
      if (!Object.hasOwn(destinations, event.key)) return;
      event.preventDefault();
      available[destinations[event.key]].click();
      available[destinations[event.key]].focus();
    });
  }

  window.addEventListener("pagehide", worldImport.cancel);
  window.addEventListener("pageshow", event => {
    if (event.persisted && isDirty()) {
      reset(true);
      setBusy(false);
      onEdit();
    }
  });

  return {
    create() {
      reset(true);
      studio.dataset.status = "setup";
      element("world-status").textContent = "Setup";
      showCover("");
      element("embedding-name").textContent = "Gemini Embedding 2";
      element("embedding-spec").textContent = "768 dimensions · 8,192 token limit";
      describeSetup();
      setBusy(false);
      content.hidden = false;
      access.hidden = true;
    },
    close() {
      if (dialog.open) dialog.close("cancel");
      worldImport.cancel();
      reset(false);
    },
    isDirty,
    async confirmLeave() {
      if (!isDirty()) return true;
      if (dialog.open) {
        dialog.close("cancel");
        await answer;
      }
      return ask("Discard Unsaved Setup?",
        "Your World name, selected books, and settings will be cleared if you leave.",
        "Keep Editing", "Discard Setup", true);
    },
    setActionError(text) { setError("action-error", text); },
  };
}
