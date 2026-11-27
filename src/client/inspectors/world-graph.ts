import type { InspectorMap, InspectorOverview, InspectorRecordDetail } from "../../shared/inspectors.js";
import { choices, count, el, heading, iconControl, muted, notice, reader, setIconControl } from "./ui.js";
import { createGraphMap } from "./graph-map.js";
import { graphBrowser, graphConnections, revealGraphDetail } from "./graph-browser.js";

type ReadGraph = {
  map(publishedOnly: boolean, revision: string): Promise<InspectorMap | { revision: string }>;
  record(recordId: string, publishedOnly: boolean): Promise<InspectorRecordDetail>;
};

export function graphView(readGraph: ReadGraph, openSource: (marker: string, revision: number) => void) {
  const root = el("div", "inspector-list inspector-world-graph");
  const mapIssue = el("div", "inspector-graph-map-issue");
  let data: InspectorOverview | undefined;
  let detail: HTMLElement | undefined;
  let selected: InspectorRecordDetail | undefined;
  let recordId: string | undefined;
  let trigger: HTMLElement | undefined;
  let renderDetail: (() => void) | undefined;
  let mapRequest = 0;
  let detailRequest = 0;
  let mapRevision = "";
  let overviewRevision = "";
  let mapPending = false;
  let ready = false;
  let paused = false;

  const retrieval = iconControl("Ready for Retrieval", "check", () => {
    ready = !ready;
    retrieval.setAttribute("aria-pressed", String(ready));
    retrieval.dataset.tooltip = ready ? "Ready for Retrieval · Return to working graph" : "Ready for Retrieval · Show published graph";
    closeDetail(false);
    mapRevision = "";
    void populateMap(true);
  });
  retrieval.setAttribute("aria-pressed", "false");
  retrieval.dataset.tooltip = "Ready for Retrieval · Show published graph";
  const pause = iconControl("Pause Graph", "pause", () => {
    paused = !paused;
    map.pause(paused);
    pause.setAttribute("aria-pressed", String(paused));
    setIconControl(pause, paused ? "Resume Graph" : "Pause Graph", paused ? "play" : "pause");
    if (!paused) void populateMap();
  });
  pause.setAttribute("aria-pressed", "false");
  const map = createGraphMap(id => { void openDetail(id); }, "World Graph");
  const mapControls = el("div", "inspector-controls inspector-map-live-controls");
  mapControls.append(retrieval, pause);
  map.zoomControls.after(mapControls);
  const browser = graphBrowser(map.focus);
  root.append(map.root, mapIssue, browser.root);

  async function populateMap(force = false) {
    if (!data || (!force && (paused || mapPending || overviewRevision === data.revision))) return;
    const request = ++mapRequest;
    const revision = data.revision;
    mapPending = true;
    try {
      const result = await readGraph.map(ready, mapRevision);
      if (request !== mapRequest || !root.isConnected || (paused && !force)) return;
      mapIssue.replaceChildren();
      overviewRevision = revision;
      mapRevision = result.revision;
      if ("nodes" in result) {
        map.load(result);
        const records = [...result.nodes, ...result.edges].sort((a, b) =>
          b.source_notes - a.source_notes || a.name.localeCompare(b.name));
        browser.update(records);
        map.showEmpty(result.nodes.length ? "" : ready ? "No published graph is available." : "No graph records yet.");
        if (recordId) void openDetail(recordId, true);
      }
    } catch (error) {
      if (request === mapRequest && root.isConnected) mapIssue.replaceChildren(notice(error, () => { void populateMap(true); }));
    } finally {
      if (request === mapRequest) mapPending = false;
    }
  }

  function closeDetail(restore = true) {
    if (!detail) return;
    detailRequest++;
    detail.remove();
    detail = selected = undefined;
    recordId = undefined;
    renderDetail = undefined;
    map.select();
    if (restore) trigger?.focus({ preventScroll: true });
    trigger = undefined;
  }

  async function openDetail(id: string, refresh = false) {
    if (!data) return;
    if (!refresh) {
      const active = document.activeElement;
      if (!detail) {
        trigger = active instanceof HTMLElement && root.contains(active) ? active : map.canvas;
        detail = el("section", "inspector-list inspector-graph-explorer");
        detail.setAttribute("aria-label", "Graph Record");
        browser.details.append(detail);
      }
      recordId = id;
      selected = undefined;
      renderDetail = undefined;
    }
    const target = detail;
    if (!target) return;
    const request = ++detailRequest;
    const revision = data.world.book_revision;
    const close = iconControl("Close Graph Record", "close", () => closeDetail());
    if (!refresh) target.replaceChildren(heading("Graph Record", close), muted("Loading graph record…"));
    try {
      const record = await readGraph.record(id, ready);
      if (request !== detailRequest || target !== detail || !root.isConnected) return;
      if (selected?.version === record.version) { renderDetail?.(); return; }
      selected = record;
      if (refresh && renderDetail) { renderDetail(); return; }

      const head = heading(record.name, close);
      const meta = el("div", "inspector-controls inspector-graph-meta");
      const badge = el("span", "inspector-extraction-type");
      badge.dataset.kind = record.type ? "entity" : "relationship";
      const sourceCount = el("span", "inspector-muted");
      meta.append(badge, sourceCount);
      const connected = graphConnections(map);
      const pending = muted("Pending Summarization");
      const description = el("div");
      let view: "raw" | "summary" = record.summary ? "summary" : "raw";
      const toggle = choices([["summary", "Summarized"], ["raw", "Raw"]], view, value => { view = value; renderDetail?.(); });
      const summaryTab = toggle.firstElementChild as HTMLButtonElement;
      const last = { text: undefined as string | undefined, view };
      renderDetail = () => {
        const item = selected!;
        summaryTab.disabled = item.summary === null;
        pending.hidden = !summaryTab.disabled;
        badge.textContent = item.type ?? "Relationship";
        sourceCount.textContent = `${count(item.chunks)} ${item.chunks === 1 ? "source chunk" : "source chunks"}`;
        connected.update(item.id, item.type === null);
        const text = view === "raw" ? item.raw : item.summary ?? "";
        if (text === last.text && view === last.view) return;
        last.text = text; last.view = view;
        description.replaceChildren(text ? reader(text, view === "raw" ? "Raw Description" : "Summarized Description",
          marker => openSource(marker, revision)) : muted("No description available."));
      };
      target.replaceChildren(head, meta, toggle, pending, description, connected.root);
      renderDetail();
      if (!refresh) revealGraphDetail(head);
    } catch (error) {
      if (request === detailRequest && !refresh && root.isConnected) {
        const head = heading("Graph Record", close);
        target.replaceChildren(head, notice(error, () => { void openDetail(id); }));
        revealGraphDetail(head);
      }
    }
  }

  return {
    root,
    update(overview: InspectorOverview) {
      if (data && data.world.book_revision !== overview.world.book_revision) closeDetail(false);
      data = overview;
      void populateMap();
    },
    escape() { if (!detail) return false; closeDetail(); return true; },
    close() { mapRequest++; detailRequest++; map.close(); },
  };
}
