const panel = document.getElementById("books-panel");
const list = document.getElementById("book-list");
const picker = document.getElementById("book-files");
const add = document.getElementById("add-books");
const browse = document.getElementById("browse-books");
const drop = document.getElementById("book-drop");
const dropHint = document.getElementById("book-drop-hint");
const summary = document.getElementById("books-summary");
const error = document.getElementById("books-error");
const indexed = document.getElementById("books-indexed");
const worldTop = document.getElementById("world-top");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const dragThresholdPx = 4;
const scrollEdgePx = 56;
const maxScrollPerFramePx = 14;

const icons = {
  grip: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01",
  pencil: "m15 5 4 4M4 20l4-.8L20 7a2.8 2.8 0 0 0-4-4L4.8 16Z",
  check: "m5 12 4 4L19 6",
  remove: "m6 6 12 12M18 6 6 18",
  reset: "M3 12a9 9 0 1 0 2.64-6.36L3 8M3 3v5h5",
};

function element(tag, className, text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function setIcon(button, icon) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", icons[icon]);
  if (icon === "grip") path.setAttribute("stroke-width", "3");
  svg.append(path);
  button.replaceChildren(svg);
}

function bookButton(icon, label, onClick) {
  const button = element("button", "icon-button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  if (onClick) button.addEventListener("click", onClick);
  setIcon(button, icon);
  return button;
}

export function initBooksPanel(onEdit, editSaved) {
  let selected = [];
  let saved = null;
  let locked = false;
  let jobChanging = false;
  let drag = null;
  let snapshot = "";
  const rowMotions = new WeakMap();

  function showError(text) {
    error.hidden = !text;
    error.textContent = text;
  }

  function addFiles(files) {
    if (saved || locked) return;
    const rejected = [];
    for (const file of files) {
      if (!/\.txt$/i.test(file.name) || !file.size) {
        rejected.push(file.name);
        continue;
      }
      selected.push({ file, filename: file.name, name: file.name.slice(0, -4) });
    }
    picker.value = "";
    showError(rejected.length ? `Select nonempty TXT files. Skipped ${rejected.join(", ")}.` : "");
    render();
    onEdit();
  }

  function canEditSaved() {
    return saved && !locked && !jobChanging && !saved.id.startsWith("demo-")
      && ["paused", "failed", "ready"].includes(saved.status);
  }

  async function move(book, destination) {
    const books = saved?.books ?? selected;
    const origin = saved ? books.findIndex(item => item.id === book.id) : books.indexOf(book);
    if (origin < 0 || destination < 0 || destination >= books.length || locked) return;
    if (saved) {
      const order = books.map(item => item.id);
      order.splice(origin, 1);
      order.splice(destination, 0, book.id);
      await editSaved(saved, "book-order", order);
      const row = [...list.children].find(item => item.dataset.bookId === book.id);
      row?.querySelector(".book-handle")?.focus();
      return;
    }
    selected.splice(origin, 1);
    selected.splice(destination, 0, book);
    render();
    onEdit();
    list.children[destination]?.querySelector(".book-handle")?.focus();
  }

  function slideRow(row, fromTop, lifted = false) {
    rowMotions.get(row)?.cancel();
    const offset = fromTop - row.getBoundingClientRect().top;
    if (reducedMotion.matches || (!offset && !lifted)) return;
    const motion = row.animate([
      { translate: `0 ${offset}px`, scale: lifted ? 1.012 : 1 },
      { translate: "0 0", scale: 1 },
    ], { duration: 220, easing: "cubic-bezier(.22, 1, .36, 1)" });
    rowMotions.set(row, motion);
  }

  function updateDrag() {
    const { row, grab, y } = drag;
    const upper = Math.max(0, worldTop.getBoundingClientRect().bottom);
    const lift = upper + scrollEdgePx - y;
    const lower = y - (window.innerHeight - scrollEdgePx);
    if (lift > 0) window.scrollBy(0, -Math.min(maxScrollPerFramePx, lift / 3));
    else if (lower > 0) window.scrollBy(0, Math.min(maxScrollPerFramePx, lower / 3));

    const top = y - list.getBoundingClientRect().top - grab;
    const center = top + row.offsetHeight / 2;
    while (true) {
      const previous = row.previousElementSibling;
      const next = row.nextElementSibling;
      const moveUp = previous && center < previous.offsetTop + previous.offsetHeight / 2;
      const moveDown = next && center > next.offsetTop + next.offsetHeight / 2;
      if (!moveUp && !moveDown) break;

      const neighbor = moveUp ? previous : next;
      const previousTop = neighbor.getBoundingClientRect().top;
      list.insertBefore(row, moveUp ? previous : next.nextElementSibling);
      slideRow(neighbor, previousTop);
      const draggedNumber = row.querySelector(".book-number");
      const neighborNumber = neighbor.querySelector(".book-number");
      [draggedNumber.textContent, neighborNumber.textContent] = [neighborNumber.textContent, draggedNumber.textContent];
    }
    row.style.setProperty("--drag-offset", `${top - row.offsetTop}px`);
    drag.frame = requestAnimationFrame(updateDrag);
  }

  function clearDrag() {
    if (!drag) return;
    const { pointer, frame } = drag;
    drag = null;
    cancelAnimationFrame(frame);
    if (list.hasPointerCapture(pointer)) list.releasePointerCapture(pointer);
  }

  function finishDrag(event) {
    if (drag?.pointer !== event.pointerId) return;
    if (!drag.frame) {
      clearDrag();
      return;
    }
    const lifted = drag.row;
    const rows = [...list.children];
    if (saved) {
      const world = saved;
      const order = rows.map(row => row.dataset.bookId);
      clearDrag();
      render();
      if (event.type === "pointerup" && order.some((id, index) => id !== world.books[index].id)) {
        editSaved(world, "book-order", order);
      }
      return;
    }
    const tops = rows.map(row => row.getBoundingClientRect().top);
    selected = rows.map(row => selected[Number(row.dataset.index)]);
    const dragIndex = rows.indexOf(lifted);
    clearDrag();
    render();
    [...list.children].forEach((row, index) => slideRow(row, tops[index], index === dragIndex));
    onEdit();
  }

  list.addEventListener("pointerdown", event => {
    const area = event.target.closest(".book-drag-area[data-reorder]");
    if (!area || drag || event.button !== 0 || !event.isPrimary) return;
    const row = area.closest(".book-row");
    drag = { row, pointer: event.pointerId, y: event.clientY, grab: event.clientY - row.getBoundingClientRect().top };
  });
  window.addEventListener("pointermove", event => {
    if (drag?.pointer !== event.pointerId) return;
    const previousY = drag.y;
    drag.y = event.clientY;
    if (drag.frame) return;
    if (Math.abs(drag.y - previousY) < dragThresholdPx) {
      drag.y = previousY;
      return;
    }
    list.setPointerCapture(event.pointerId);
    rowMotions.get(drag.row)?.cancel();
    drag.row.dataset.dragging = "";
    updateDrag();
  });
  window.addEventListener("pointerup", finishDrag);
  window.addEventListener("pointercancel", finishDrag);
  list.addEventListener("lostpointercapture", finishDrag);

  function reorderHandle(dragArea, order, book, index, allowed) {
    const handle = bookButton("grip", `Reorder Book ${index + 1}. Use Up or Down Arrow.`);
    handle.classList.add("book-handle");
    handle.addEventListener("keydown", event => {
      if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      move(book, index + (event.key === "ArrowUp" ? -1 : 1));
    });
    order.prepend(handle);
    function allowReorder(allow) {
      dragArea.toggleAttribute("data-reorder", allow);
      handle.disabled = !allow;
    }
    allowReorder(allowed);
    return allowReorder;
  }

  function editRow(row, dragArea, order, title, book, index) {
    const defaultName = book.filename.slice(0, -4);
    const titleText = element("span", "book-name-text", book.name.trim() || defaultName);
    titleText.title = titleText.textContent;
    const input = element("input", "book-title-input");
    input.type = "text";
    input.autocomplete = "off";
    input.placeholder = defaultName;
    input.setAttribute("aria-label", `Book ${index + 1} title`);
    const reset = bookButton("reset", "Reset title to filename", () => {
      input.value = defaultName;
      input.focus();
      input.select();
    });
    reset.classList.add("reset-book-title");
    reset.addEventListener("pointerdown", event => event.preventDefault());
    const editField = element("div", "book-edit-field");
    editField.hidden = true;
    editField.append(input, reset);
    title.append(titleText, editField);

    const controls = element("div", "book-controls");
    const canReorder = !locked && selected.length > 1;
    const allowReorder = reorderHandle(dragArea, order, book, index, canReorder);

    function endEdit(save) {
      if (editField.hidden) return;
      if (save) book.name = input.value.trim() || defaultName;
      const updatedName = book.name.trim() || defaultName;
      titleText.textContent = updatedName;
      titleText.title = updatedName;
      setIcon(rename, "pencil");
      rename.setAttribute("aria-label", `Rename Book ${index + 1}`);
      editField.hidden = true;
      titleText.hidden = false;
      delete row.dataset.editing;
      allowReorder(canReorder);
      if (save) onEdit();
    }

    function beginEdit() {
      if (locked) return;
      input.value = book.name;
      editField.hidden = false;
      titleText.hidden = true;
      row.dataset.editing = "";
      allowReorder(false);
      setIcon(rename, "check");
      rename.setAttribute("aria-label", `Save title for Book ${index + 1}`);
      input.focus();
      input.select();
    }

    const rename = bookButton("pencil", `Rename Book ${index + 1}`, () => {
      if (editField.hidden) beginEdit();
      else {
        endEdit(true);
        rename.focus();
      }
    });
    rename.classList.add("rename-book");
    rename.disabled = locked;
    rename.addEventListener("pointerdown", event => { if (!editField.hidden) event.preventDefault(); });
    titleText.addEventListener("dblclick", beginEdit);
    input.addEventListener("keydown", event => {
      if (event.key === "Tab") {
        const nextRow = event.shiftKey ? row.previousElementSibling : row.nextElementSibling;
        const nextRename = nextRow?.querySelector(".rename-book");
        if (nextRename) {
          event.preventDefault();
          endEdit(true);
          nextRename.click();
        }
        return;
      }
      if (!["Enter", "Escape"].includes(event.key)) return;
      event.preventDefault();
      endEdit(event.key === "Enter");
      rename.focus();
    });
    title.addEventListener("focusout", event => {
      if (!title.contains(event.relatedTarget)) endEdit(true);
    });

    const remove = bookButton("remove", `Remove Book ${index + 1}`, () => {
      selected.splice(index, 1);
      render();
      onEdit();
      (list.children[Math.min(index, list.children.length - 1)]?.querySelector(".book-controls button") ?? add).focus();
    });
    remove.disabled = locked;
    controls.append(rename, remove);
    row.append(controls);
  }

  function savedRow(row, title, book, nextBook) {
    const titleText = element("span", "book-name-text", book.name);
    titleText.title = book.name;
    title.append(titleText);
    let status = "Queued";
    if (book.embedded_chunks === book.total_chunks) status = "Indexed";
    else if (book.number === nextBook && saved.status === "paused") status = "Paused";
    else if (book.number === nextBook && saved.status === "failed") status = "Failed";
    else if (book.number === saved.active_book) status = saved.status === "pausing" ? "Pausing…" : "Embedding";
    const progress = Math.floor(book.embedded_chunks * 100 / book.total_chunks);
    const total = book.total_chunks.toLocaleString();
    const done = book.embedded_chunks.toLocaleString();
    const counts = status === "Indexed" ? `${total} chunks` : `${done} / ${total} chunks`;
    const progressLabel = status === "Embedding" ? `Embedding ${progress}%`
      : status === "Paused" ? `Paused · ${progress}%` : status;
    const info = element("div", "book-status");
    const statusText = element("strong", "");
    if (status === "Indexed") setIcon(statusText, "check");
    statusText.append(progressLabel);
    info.dataset.state = status;
    info.append(element("span", "", counts), statusText);
    row.append(info);
  }

  function render() {
    clearDrag();
    const books = saved?.books ?? selected;
    const editable = canEditSaved();
    const complete = books.filter(book => book.embedded_chunks === book.total_chunks).length;
    indexed.hidden = !saved;
    summary.textContent = saved?.status === "ready"
      ? `${books.length} ${books.length === 1 ? "Book" : "Books"} · All Indexed`
      : saved?.status === "failed"
        ? `${complete} of ${books.length} Indexed · Error requires attention`
        : `${complete} of ${books.length} Books Indexed`;
    add.hidden = Boolean(saved);
    drop.hidden = Boolean(saved) || books.length > 0;
    add.disabled = browse.disabled = locked;
    const nextBook = saved?.books.find(book => book.embedded_chunks < book.total_chunks)?.number;

    const rows = [];
    for (const [index, book] of books.entries()) {
      const row = element("li", "book-row");
      const title = element("div", "book-name");
      row.dataset.index = index;
      const order = element("div", "book-order");
      order.append(element("span", "book-number", String(index + 1)));
      if (saved && !editable) {
        row.append(order, title);
        savedRow(row, title, book, nextBook);
      } else {
        const dragArea = element("div", "book-drag-area");
        dragArea.append(order, title);
        row.append(dragArea);
        if (saved) {
          row.dataset.bookId = book.id;
          reorderHandle(dragArea, order, book, index, books.length > 1);
          savedRow(row, title, book, nextBook);
          const controls = element("div", "book-controls");
          const remove = bookButton("remove", `Remove Book ${index + 1}: ${book.name}`, async () => {
            if (await editSaved(saved, "remove-book", book)) add.focus();
          });
          remove.disabled = books.length < 2;
          controls.append(remove);
          row.append(controls);
        } else {
          editRow(row, dragArea, order, title, book, index);
        }
      }
      const filename = element("small", "", book.filename);
      filename.title = book.filename;
      title.append(filename);
      rows.push(row);
    }
    list.replaceChildren(...rows);
  }

  function isFileDrop(event) {
    return !saved && !locked && event.dataTransfer.types.includes("Files");
  }

  add.addEventListener("click", () => picker.click());
  browse.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => addFiles(picker.files));
  panel.addEventListener("dragover", event => {
    if (!isFileDrop(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    panel.classList.add("is-file-target");
    dropHint.hidden = false;
  });
  panel.addEventListener("dragleave", event => {
    if (panel.contains(event.relatedTarget)) return;
    panel.classList.remove("is-file-target");
    dropHint.hidden = true;
  });
  panel.addEventListener("drop", event => {
    if (!isFileDrop(event)) return;
    event.preventDefault();
    panel.classList.remove("is-file-target");
    dropHint.hidden = true;
    addFiles(event.dataTransfer.files);
  });

  return {
    reset() {
      selected = [];
      saved = null;
      locked = false;
      jobChanging = false;
      snapshot = "";
      showError("");
      render();
    },
    show(world, pending = false) {
      const nextSnapshot = JSON.stringify([world.id, world.books, world.status, world.active_book, pending]);
      saved = world;
      jobChanging = pending;
      if (snapshot === nextSnapshot) return;
      snapshot = nextSnapshot;
      render();
    },
    setLocked(value) {
      if (locked === value) return;
      locked = value;
      render();
    },
    showError,
    get selected() {
      return selected;
    },
  };
}
