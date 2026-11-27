import type { GraphTrace, MessageContext } from "../../shared/inspectors.js";
import { graphBrowser, graphConnections, revealGraphDetail } from "./graph-browser.js";
import { createGraphMap } from "./graph-map.js";
import { el, heading, iconControl, muted, reader } from "./ui.js";

function retrievalGroup(record: GraphTrace) {
  switch (record.reason) {
    case "Exact match": return "Exact Matches";
    case "Meaning match": return "Meaning Matches";
    case "Preview Seeds": return "Seeds";
    default: return record.reason;
  }
}

function groupOrder(group: string) {
  switch (group) {
    case "Exact Matches":
    case "Seeds": return -1;
    case "Meaning Matches": return 0;
    default: return Number(group.slice(4));
  }
}

export function createMessageContextGraph(trace: MessageContext["trace"]) {
  const preview = trace.graph_preview;
  const capturedGraph = preview ?? trace;
  const records = capturedGraph.graph.filter(record => record.included);
  const recordsById = new Map(records.map(record => [String(record.id), record]));
  const endpointsById = new Map(capturedGraph.endpoints.map(endpoint => [String(endpoint.id), endpoint]));
  const map = createGraphMap(openRecord, "Message Context Graph");
  const browser = graphBrowser(map.focus);
  const body = el("div", "inspector-xray-graph-body");
  body.append(map.root, browser.root);
  let detail: HTMLElement | undefined;

  const content = preview
    ? [muted("Temporary preview from saved extraction. These notes were not sent with this reply."), body]
    : [body];

  function closeRecord() {
    if (!detail) return false;
    detail.remove();
    detail = undefined;
    map.select();
    map.canvas.focus({ preventScroll: true });
    return true;
  }

  function openRecord(id: string) {
    const record = recordsById.get(id);
    const item = record ?? endpointsById.get(id);
    if (!item) return;

    detail?.remove();
    detail = el("section", "inspector-list inspector-graph-explorer");
    detail.setAttribute("aria-label", "Graph Record");
    const title = heading(item.name, iconControl("Close Graph Record", "close", closeRecord));
    const badge = el("span", "inspector-extraction-type", item.type ?? "Relationship");
    badge.dataset.kind = item.type ? "entity" : "relationship";
    const meta = el("div", "inspector-controls inspector-graph-meta");
    let status = "Relationship endpoint";
    if (record) {
      const reason = record.reason === "Preview Seeds" ? "Seeds" : record.reason;
      const inclusion = preview ? "Preview" : "Included";
      status = `${reason} · ${inclusion}`;
    }
    meta.append(badge, el("span", "inspector-muted", status));
    detail.append(title, meta);
    if (record) detail.append(reader(record.description, "Description"));

    const connections = graphConnections(map);
    connections.update(id, item.type === null);
    detail.append(connections.root);
    browser.details.append(detail);
    revealGraphDetail(title);
  }

  function loadGraph() {
    const nodes = new Map(records.filter(record => record.source == null || record.target == null).map(record =>
      [record.id, { id: String(record.id), name: record.name, type: record.type, version: "captured", muted: false }]));
    const edges = records.flatMap(record => record.source == null || record.target == null ? [] : [{
      id: String(record.id), source: String(record.source), target: String(record.target), name: record.name,
      type: null, version: "captured",
    }]);

    // An edge can use an endpoint whose own description was outside the retrieval budget.
    const endpointIds = new Set(edges.flatMap(edge => [edge.source, edge.target]));
    const endpointsWithoutNotes = [];
    for (const endpoint of capturedGraph.endpoints) {
      const id = String(endpoint.id);
      if (nodes.has(endpoint.id) || !endpointIds.has(id)) continue;
      nodes.set(endpoint.id, { ...endpoint, id, version: "endpoint", muted: true });
      endpointsWithoutNotes.push({ id, name: endpoint.name, type: endpoint.type, group: "Relationship Endpoints" });
    }
    map.load({ nodes: [...nodes.values()], edges });

    const groups = new Map<string, GraphTrace[]>();
    for (const record of records) {
      const group = retrievalGroup(record);
      const entries = groups.get(group);
      if (entries) entries.push(record);
      else groups.set(group, [record]);
    }
    const orderedGroups = [...groups].sort(([left], [right]) => groupOrder(left) - groupOrder(right));
    const notes = orderedGroups.flatMap(([group, entries]) => entries.map(record => ({
      id: String(record.id), name: record.name, type: record.type, group, text: record.description,
    })));
    browser.update(notes, endpointsWithoutNotes);
  }

  loadGraph();
  return {
    content,
    closeRecord,
    close() {
      map.close();
      map.root.remove();
      detail?.remove();
    },
  };
}
