import type { DatabaseSync } from "node:sqlite";
import type { World } from "../../shared/types.js";
import { identifier, RequestError, whole } from "../validation.js";
import { WorldInspectorGraph } from "./inspector-graph.js";
import type { IndexActivity } from "./index-activity.js";
import type { ActivityDetail, InspectorOverview, InspectorStage } from "../../shared/inspectors.js";
import { requireWorld } from "./storage.js";

function stages(world: World, activeNames: string[]): InspectorStage[] {
  const live = world.status === "creating" || world.status === "pausing";
  const quiet = world.status === "paused" ? "Paused" : world.status === "failed" ? "Interrupted" : "Waiting";
  const active = (...names: string[]) => live && names.some(name => activeNames.includes(name));
  const stage = (name: string, done: number, total: number | null, running: boolean, complete = total !== null && total > 0 && done === total) =>
    ({ name, done, total, status: complete ? "Complete" : running ? "Running" : quiet });
  const bookStages = [
    stage("Split books", world.total_chunks, null, false, world.total_chunks > 0),
    stage("Embed chunks", world.embedded_chunks, world.total_chunks, active("Chunk embedding")),
  ];
  if (!world.graph) return bookStages;

  const extractedChunks = world.books.reduce((total, book) => total + book.extracted_chunks, 0);
  const extracting = live && activeNames.some(name => name === "Initial extraction" || name.startsWith("Gleaning pass"));
  const progress = world.graph_progress;
  return [
    ...bookStages,
    stage("Extract graph notes", extractedChunks, world.total_chunks, extracting),
    stage("Resolve graph", progress?.combined ?? 0, null, active("Graph resolution"), Boolean(progress)),
    stage("Summarize graph", progress?.summarized ?? 0, progress?.combined ?? null, active("Graph summary"),
      progress != null && progress.summarized === progress.combined),
    stage("Embed graph", progress?.embedded ?? 0, progress?.combined ?? null, active("Graph embedding"),
      progress != null && progress.embedded === progress.combined),
    stage("Publish graph", Number(world.status === "ready"), 1, active("Graph publication")),
  ];
}

export class WorldInspector {
  private readonly graph: WorldInspectorGraph;

  constructor(private db: DatabaseSync, private activity: IndexActivity, private readWorldDetail: (id: string) => World) {
    this.graph = new WorldInspectorGraph(db);
  }

  overview(id: string): InspectorOverview {
    const row = requireWorld(this.db, id);
    const world = this.readWorldDetail(id);
    const graph = this.graph.summary(row);
    const activity = this.activity.snapshot(id);
    return { world, stages: stages(world, activity.active.map(item => item.name)),
      ...activity, ...graph };
  }

  activityDetail(id: string, operation: number): ActivityDetail {
    requireWorld(this.db, id);
    const detail = this.activity.detail(id, operation);
    if (!detail) throw new RequestError("This activity has expired.", 404);
    return detail;
  }

  route(id: string, action: string, params: URLSearchParams) {
    const integer = (key: string, min = 0) => whole(Number(params.get(key)), min, "Choose an available inspector item.");
    const ready = params.get("ready") === "1";
    switch (action) {
      case "inspector": return this.overview(id);
      case "inspector-activity": return this.activityDetail(id, integer("operation", 1));
      case "inspector-map": return this.graph.map(requireWorld(this.db, id), ready, params.get("revision"));
      case "inspector-records": {
        const kind = params.get("kind");
        const offset = integer("offset");
        return this.graph.list(requireWorld(this.db, id), ready, {
          kind: kind === "all" || kind === "relationships" ? kind : "entities",
          search: (params.get("q") ?? "").slice(0, 512),
          ascending: params.get("asc") === "1",
          offset,
          entityType: params.get("type") ?? "",
        });
      }
      case "inspector-record": return this.graph.record(requireWorld(this.db, id), params.get("record") ?? "", ready);
      default: throw new RequestError("Inspector view not found.", 404);
    }
  }
}
