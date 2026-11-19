import { editName, element, errorText, iconButton } from "./controls.js";
import { renderReply } from "./markdown.js";

function turnNode(message) {
  const turn = document.createElement("article");
  turn.className = `tale-turn ${message.role}`;
  const reading = document.createElement("div");
  if (message.role === "user") {
    reading.textContent = message.content;
    turn.append(reading);
    return { turn };
  }

  const thoughts = document.createElement("details");
  thoughts.className = "tale-thoughts";
  const label = document.createElement("summary");
  const thinking = document.createElement("div");
  thoughts.append(label, thinking);
  const stopped = document.createElement("p");
  stopped.className = "tale-stopped";
  stopped.textContent = "Stopped";
  reading.className = "tale-reply";
  turn.append(thoughts, reading, stopped);
  return {
    turn,
    render() {
      turn.hidden = !message.content && !message.thinking && message.status === "error";
      thoughts.hidden = !message.thinking;
      label.textContent = message.status === "generating" && !message.content ? "Thinking…" : "Thought process";
      thinking.textContent = message.thinking;
      stopped.hidden = message.status !== "stopped";
      if (reading.dataset.source !== message.content) {
        renderReply(reading, message.content);
        reading.dataset.source = message.content;
      }
    },
  };
}

export function initTaleChat({ request, settings, onActivity }) {
  const reading = element("tale-reading");
  const chapter = element("tale-chapter");
  const messages = element("tale-messages");
  const prompt = element("tale-prompt");
  const composer = element("tale-composer");
  const input = element("tale-input");
  const submit = element("send-tale");
  const stop = element("stop-tale");
  const pulse = element("tale-pulse");
  const settingsButton = element("chat-tale-settings");
  const titleError = element("tale-title-error");
  let current;
  let generation;
  let watcher;
  let updatingTitle = false;

  function resetHeight() {
    input.style.height = "";
    if (input.value && input.getClientRects().length) input.style.height = `${input.scrollHeight}px`;
  }

  function updateComposer() {
    const active = Boolean(generation);
    submit.hidden = active;
    stop.hidden = !active || !generation?.controller;
    stop.disabled = Boolean(generation?.stopping);
    submit.disabled = active || !input.value.trim();
    pulse.hidden = !active;
  }

  function bottom() {
    reading.scrollTop = reading.scrollHeight;
  }

  function nearBottom() {
    return reading.scrollHeight - reading.scrollTop - reading.clientHeight < 80;
  }

  function drawTitle(tale) {
    if (updatingTitle) return;
    const line = document.createElement("div");
    line.className = "tale-title-line";
    const title = document.createElement("h1");
    title.textContent = tale.title;
    const pencil = iconButton("Rename Tale", "✎");
    line.append(title, pencil);
    chapter.replaceChildren(line);
    document.title = `${tale.title} · TaleSide`;
    pencil.addEventListener("click", () => {
      updatingTitle = true;
      errorText(titleError);
      editName(line, title.textContent, "Tale title", async value => {
        await request(`${tale.api}/rename`, { method: "POST", json: { title: value } });
        if (current === tale) {
          title.textContent = tale.title = value;
          document.title = `${value} · TaleSide`;
        }
      }, () => {
        if (current !== tale) return;
        updatingTitle = false;
        errorText(titleError);
        pencil.focus();
      }, message => errorText(titleError, message));
    });
  }

  function append(message) {
    const node = turnNode(message);
    messages.append(node.turn);
    node.render?.();
    return node;
  }

  function stopRequest(active, leaving = false) {
    if (!active?.controller) return;
    const userStopped = active.stopping || !leaving;
    active.stopping = true;
    updateComposer();
    const options = {
      method: "POST", keepalive: leaving,
      json: { generation_id: active.id, user_stopped: userStopped },
    };
    request(`${active.api}/stop`, options).catch(() => active.controller.abort());
    if (leaving) active.controller.abort();
  }

  function close() {
    stopRequest(generation, true);
    clearTimeout(watcher);
    current = generation = null;
    updatingTitle = false;
    input.value = "";
    resetHeight();
    updateComposer();
    composer.hidden = true;
    prompt.hidden = true;
    messages.replaceChildren();
    chapter.replaceChildren();
    errorText(titleError);
  }

  async function settle(tale, active) {
    if (active.recovering && current === tale) {
      try {
        const saved = await request(tale.api);
        if (current !== tale) return;
        const last = saved.messages.at(-1);
        if (last?.status === "generating") {
          watcher = setTimeout(() => settle(tale, active), 250);
          return;
        }
        if (active.assistant && last?.role === "assistant") Object.assign(active.assistant, last);
        if (active.node) active.node.render();
      } catch {
        // The next open will read the saved transcript.
      }
    }
    if (current !== tale || generation !== active) return;
    generation = null;
    updateComposer();
    onActivity();
  }

  async function send(event) {
    event.preventDefault();
    const tale = current;
    const text = input.value.trim();
    if (!tale || !text || generation) return;
    const controller = new AbortController();
    const active = { controller, id: crypto.randomUUID().replaceAll("-", ""), api: tale.api };
    generation = active;
    updateComposer();
    bottom();
    let accepted = false;
    try {
      const response = await fetch(`${tale.api}/generate`, {
        method: "POST", signal: controller.signal, cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, generation_id: active.id }),
      });
      if (current !== tale) return;
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (result.missing_key) settings.open(settingsButton, result.missing_key);
        return;
      }
      accepted = true;
      prompt.hidden = true;
      append({ role: "user", content: text });
      active.assistant = { role: "assistant", content: "", thinking: "", status: "generating" };
      active.node = append(active.assistant);
      input.value = "";
      resetHeight();
      bottom();
      request(tale.api).then(saved => {
        if (current !== tale) return;
        tale.title = saved.title;
        if (chapter.querySelector("h1")?.textContent !== saved.title) drawTitle(tale);
      }).catch(() => {});

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || current !== tale) break;
          buffer += value;
          const lines = buffer.split("\n");
          buffer = lines.pop();
          const follow = nearBottom();
          for (const line of lines) {
            if (!line) continue;
            const packet = JSON.parse(line);
            if (packet.type === "reply") active.assistant.content += packet.text;
            else if (packet.type === "thinking") active.assistant.thinking += packet.text;
            else if (packet.type === "done") active.assistant.status = packet.status;
          }
          active.node.render();
          if (follow) bottom();
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch {
      // The server retains any partial turn from a disconnected request.
    } finally {
      if (current === tale && generation === active) {
        active.recovering = accepted && active.assistant.status === "generating";
        if (active.recovering) {
          active.assistant.status = active.stopping ? "stopped" : "error";
          active.node.render();
        }
        await settle(tale, active);
      }
    }
  }

  composer.addEventListener("submit", send);
  stop.addEventListener("click", () => stopRequest(generation));
  settingsButton.addEventListener("click", () => settings.open(settingsButton));
  input.addEventListener("input", () => {
    resetHeight();
    updateComposer();
  });
  input.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!generation && input.value.trim()) composer.requestSubmit();
  });
  window.addEventListener("pagehide", () => stopRequest(generation, true));

  async function load(tale) {
    try {
      const saved = await request(tale.api);
      if (current !== tale) return;
      const follow = !tale.loaded || nearBottom();
      tale.loaded = true;
      if (tale.world) prompt.textContent = `Ask anything about ${tale.world.name}.`;
      Object.assign(tale, { title: saved.title });
      if (!chapter.firstElementChild) drawTitle(tale);
      for (const message of saved.messages) {
        const entry = tale.turns.get(message.id);
        if (entry) {
          Object.assign(entry.message, message);
          entry.node.render?.();
        } else {
          tale.turns.set(message.id, { message, node: append(message) });
        }
      }
      prompt.hidden = saved.messages.length > 0;
      if (saved.messages.at(-1)?.status === "generating") {
        generation = { api: tale.api };
        watcher = setTimeout(() => load(tale), 350);
      } else {
        generation = null;
      }
      composer.hidden = false;
      updateComposer();
      if (follow) bottom();
    } catch (error) {
      if (current !== tale) return;
      prompt.textContent = error.message;
      prompt.hidden = false;
    }
  }

  return {
    close,
    open(path, world) {
      if (current?.path === path) return;
      close();
      current = { path, api: `/api${path}`, world, turns: new Map() };
      prompt.textContent = world ? `Ask anything about ${world.name}.` : "";
      load(current);
    },
    updateWorld(world) {
      if (!current || !world) return;
      current.world = world;
      if (current.loaded) prompt.textContent = `Ask anything about ${world.name}.`;
    },
  };
}
