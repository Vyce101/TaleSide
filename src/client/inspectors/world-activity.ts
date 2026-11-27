import type { ActivityDetail, ActivityEvent, InspectorOverview } from "../../shared/inspectors.js";
import { formatDuration, icon } from "../view.js";
import { button, choices, copyControl, count, el, heading, iconControl, locationText, muted, notice, patchList, readableRequest, reader, setIconControl, writeAnchors } from "./ui.js";

const activityTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const symbol = (event: ActivityEvent) => event.status === "running" ? "play" : event.status === "complete" ? "check"
  : event.status === "error" ? "close" : "stop";
const eventTime = (event: ActivityEvent) => activityTime.format(event.at);
const elapsedTime = (ms: number) => ms < 1000 ? `${Math.max(0, ms)} ms` : formatDuration(ms);

export function activityView(load: (id: number) => Promise<ActivityDetail>, source: (marker: string, revision: number) => void) {
  const root = el("div", "inspector-list");
  const list = el("div", "inspector-list");
  const empty = muted("");
  let latest: InspectorOverview | undefined;
  let shown: ActivityEvent[] = [];
  let running = new Set<number>();
  let capturedAt = Date.now();
  let paused = false;
  let activity: { event: ActivityEvent; container: HTMLElement; live: boolean; update: (detail: ActivityDetail) => void } | undefined;
  let pending = false;

  const pause = iconControl("Pause Live Scrolling", "pause", () => {
    paused = !paused;
    setIconControl(pause, paused ? "Resume Live Scrolling" : "Pause Live Scrolling", paused ? "play" : "pause");
    pause.setAttribute("aria-pressed", String(paused));
    if (!paused) updateList();
  });
  pause.classList.add("inspector-toggle-icon");
  pause.setAttribute("aria-pressed", "false");
  root.append(heading("Activities", pause), empty, list);

  function startDetail(event: ActivityEvent, container: HTMLElement) {
    if (activity?.event.operation === event.operation) {
      container.hidden = true;
      activity = undefined;
      return;
    }
    if (activity) activity.container.hidden = true;
    container.hidden = false;
    const panes = el("div", "inspector-activity-panes");
    const text = el("div", "inspector-list");
    const steps = el("div", "inspector-list inspector-steps");
    const status = muted("");
    const issue = el("div");
    const retryDetails = el("details", "inspector-retry-error");
    const retrySummary = el("summary");
    const retries = el("ol", "inspector-retry-reasons");
    retryDetails.append(retrySummary, retries);
    retryDetails.hidden = true;
    const headingText = el("strong");
    const output = reader("", "Output");
    const thoughts = reader("", "Thinking");
    const thoughtsBlock = el("div", "inspector-thinking");
    thoughtsBlock.append(el("strong", "", "Thinking"), thoughts);
    let selected: "input" | "output" = "input";
    let inputMode: "formatted" | "raw" = "formatted";
    let newest: ActivityDetail | undefined;
    const tabs = choices([["input", "Input"], ["output", "Output"]], selected, value => { selected = value; refreshText(true); });
    const requestModes = choices([["formatted", "Formatted"], ["raw", "Raw JSON"]], inputMode, mode => {
      inputMode = mode;
      refreshText(true);
    });
    const codeTools = el("div", "inspector-between inspector-code-tools");
    codeTools.append(requestModes, copyControl(() => output.dataset.content ?? "", output));
    text.append(tabs, issue, retryDetails, status, codeTools, headingText, thoughtsBlock, output);
    panes.append(text, steps);
    container.replaceChildren();
    if (event.location.book && event.location.chunk) {
      const marker = `B${event.location.book}:C${event.location.chunk}`;
      container.append(button(`View Chunk ${marker} →`, () => source(marker, event.revision), "inspector-link"));
    }
    container.append(panes);
    status.textContent = "Loading activity…";

    function updateReader(target: HTMLElement, value: string, label: string, streaming: boolean, force: boolean) {
      if (target.dataset.content === value && target.getAttribute("aria-label") === label && !force) return;
      target.setAttribute("aria-label", label);
      const prior = target.dataset.content ?? "";
      target.dataset.content = value;
      const selection = document.getSelection();
      const selectedText = Boolean(selection?.anchorNode && target.contains(selection.anchorNode));
      if ((streaming || selectedText) && target.firstChild instanceof Text && target.childNodes.length === 1 && value.startsWith(prior)) {
        target.firstChild.appendData(value.slice(prior.length));
      } else if (!streaming) writeAnchors(target, value, marker => source(marker, newest!.revision));
      else target.textContent = value;
    }

    function refreshText(force = false) {
      if (!newest) return;
      const input = selected === "input";
      const formatted = input ? readableRequest(newest.input) : "";
      const value = input ? inputMode === "formatted" ? formatted : newest.input : newest.output;
      requestModes.hidden = !input || newest.input === formatted;
      codeTools.hidden = !value;
      const label = selected === "input" ? "Input" : "Output";
      output.hidden = !value;
      headingText.hidden = Boolean(value);
      headingText.textContent = newest.expired ? "Activity text has expired." : `No ${label.toLowerCase()} recorded.`;
      thoughtsBlock.hidden = selected !== "output" || !newest.thinking;
      updateReader(output, value, label, newest.status === "running" && selected === "output", force);
      if (!thoughtsBlock.hidden) updateReader(thoughts, newest.thinking, "Thinking", newest.status === "running", force);
    }

    activity = {
      event, container, live: true,
      update(detail) {
        const finished = newest?.status === "running" && detail.status !== "running";
        newest = detail;
        status.textContent = [detail.clipped ? "Activity text clipped to fit the memory limit." : "",
          detail.steps_clipped ? "Some earlier request steps were omitted." : ""].filter(Boolean).join(" ");
        issue.textContent = detail.error ?? "";
        if (detail.error) issue.className = "inline-error";
        refreshText(finished);
        const reasons = detail.steps.filter(step => step.error);
        retryDetails.hidden = reasons.length === 0;
        retrySummary.textContent = `Retry Details (${reasons.length})`;
        patchList(retries, reasons, step => `${step.at}:${step.label}`, step => el("li", "", step.error!));
        patchList(steps, detail.steps, step => `${step.at}:${step.label}`, step => {
          const row = el("div", "inspector-between");
          if (step.severity) row.dataset.severity = step.severity;
          const label = step.severity === "warning" ? "Retrying" : step.label.replace(" · Attempt ", " · #");
          const request = el("span", "inspector-activity-step", label);
          if (step.key_name) request.append(el("small", "inspector-muted", step.key_name));
          row.append(request, el("span", "inspector-step-duration inspector-muted", elapsedTime(step.at - detail.started)));
          return row;
        });
      },
    };
    void refreshDetail(true);
  }

  async function refreshDetail(force = false) {
    const current = activity;
    if (!current || (!force && (paused || pending || !current.live))) return;
    pending = true;
    try {
      const detail = await load(current.event.operation);
      if (current === activity && (!paused || force) && root.isConnected) {
        current.update(detail);
        current.live = detail.status === "running";
      }
    } catch (error) {
      if (current === activity && root.isConnected && (!paused || force)) {
        current.live = false;
        current.container.replaceChildren(notice(error, () => {
          activity = undefined;
          startDetail(current.event, current.container);
        }));
      }
    } finally { pending = false; }
  }

  function activityRow(event: ActivityEvent) {
    const row = el("article", "inspector-card inspector-event");
    const details = el("div", "inspector-activity-detail");
    details.hidden = true;
    const head = button("", () => {
      const current = displayed.get(event.operation);
      if (!current) return;
      startDetail(current, details);
      for (const opened of list.querySelectorAll<HTMLButtonElement>('[aria-expanded="true"]')) {
        if (opened !== head) opened.setAttribute("aria-expanded", "false");
      }
      head.setAttribute("aria-expanded", String(!details.hidden));
    }, "inspector-event-heading");
    head.setAttribute("aria-expanded", "false");
    const glyph = el("span", "inspector-event-icon");
    const label = el("span", "inspector-event-label");
    label.append(el("strong"), el("small", "inspector-event-meta inspector-muted"));
    const timestamp = el("span", "inspector-event-time");
    timestamp.append(el("time"));
    timestamp.append(el("small", "inspector-muted inspector-event-elapsed"));
    head.append(glyph, label, timestamp, el("span", "inspector-event-chevron", "⌄"));
    row.append(head, details);
    return row;
  }

  let displayed = new Map<number, ActivityEvent>();
  function renderList() {
    displayed = new Map(shown.map(event => [event.operation, event]));
    const values = [...displayed.values()].sort((a, b) => b.operation - a.operation);
    if (activity && !displayed.has(activity.event.operation)) activity = undefined;
    const updateRow = (row: HTMLElement, event: ActivityEvent) => {
      const working = running.has(event.operation);
      const status = working ? "Running" : { running: "Running", complete: "Completed", error: "Failed", stopped: "Stopped" }[event.status];
      const statusIcon = row.querySelector<HTMLElement>(".inspector-event-icon")!;
      const glyph = working ? "play" : symbol(event);
      if (statusIcon.dataset.glyph !== glyph) { statusIcon.innerHTML = icon(glyph); statusIcon.dataset.glyph = glyph; }
      row.dataset.severity = event.severity ?? "";
      row.querySelector(".inspector-event-label strong")!.textContent = `${event.operation_name ?? event.name} · ${status}`;
      const keys = event.keys;
      const keyLabel = keys && keys.count > 1 ? `${count(keys.count)} keys` : keys?.name;
      row.querySelector(".inspector-event-meta")!.textContent = [locationText(event.location), keyLabel].filter(Boolean).join(" · ");
      row.querySelector("time")!.textContent = eventTime(event);
      const elapsed = working ? capturedAt - event.at + (event.elapsed ?? 0) : event.elapsed ?? capturedAt - event.at;
      row.querySelector(".inspector-event-elapsed")!.textContent = elapsedTime(elapsed);
    };
    patchList(list, values, item => String(item.operation), event => {
      const row = activityRow(event);
      updateRow(row, event);
      return row;
    }, updateRow);
    empty.textContent = values.length ? "" : "No indexing activity yet.";
  }

  function updateList() {
    shown = latest?.events ?? [];
    running = new Set(latest?.active.map(operation => operation.id));
    capturedAt = Date.now();
    renderList();
    void refreshDetail();
  }

  return {
    root,
    update(overview: InspectorOverview) {
      latest = overview;
      if (!paused) updateList();
    },
    escape() {
      if (!activity) return false;
      const control = activity.container.parentElement?.querySelector<HTMLButtonElement>("button");
      activity.container.hidden = true;
      control?.setAttribute("aria-expanded", "false");
      control?.focus();
      activity = undefined;
      return true;
    },
  };
}
