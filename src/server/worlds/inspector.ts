import type { DatabaseSync } from "node:sqlite";
import type { Extraction } from "../../shared/extraction.js";
import type {
  ActivityDetail, ActivityKind, ChunkStatus, InspectorBookPage, InspectorChunk, InspectorChunkRow, InspectorChunkDetail, InspectorOverview, InspectorStage,
} from "../../shared/inspectors.js";
import type { World } from "../../shared/types.js";
import { all, get } from "../sqlite.js";
import { identifier, RequestError, whole } from "../validation.js";
import { WorldInspectorGraph } from "./inspector-graph.js";
import type { IndexActivity } from "./index-activity.js";
import { precedingChunkTextSql, requireWorld, type WorldRow } from "./storage.js";

const PAGE_SIZE = 60;
type ChunkRow = { number: number; embedded: number; complete: number; started: number };
const chunkStatus = `c.number, c.vector IS NOT NULL AS embedded,
  coalesce(g.complete, 0) AS complete, g.chunk_number IS NOT NULL AS started`;
const chunkJoin = `FROM books b JOIN chunks c ON c.book_id = b.id
  LEFT JOIN graph_chunks g ON g.book_id = b.id AND g.index_number = c.index_number AND g.chunk_number = c.number`;
const chunkScope = "b.world_id = ? AND c.index_number = ?";

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

  private chunk(world: WorldRow, row: ChunkRow, book: number,
    active = this.activity.snapshot(world.id).active): InspectorChunk {
    const working = active.filter(op => op.location.book === book && op.location.chunk === row.number);
    const extracting = working.some(op => op.kind === "extraction");
    const embedding = working.some(op => op.kind === "embedding");
    return { number: row.number, embedded: Boolean(row.embedded), embedding_live: embedding,
      extraction: !world.graph_settings ? "off" : row.complete ? "complete" : extracting ? "running" : row.started ? "partial" : "pending" };
  }

  book(id: string, bookId: string, offset: number, query: string, filter: string): InspectorBookPage {
    const world = requireWorld(this.db, id);
    const book = get<{ number: number }>(this.db, "SELECT number FROM books WHERE world_id = ? AND id = ?", id, bookId);
    if (!book) throw new RequestError("This book could not be found.", 404);
    const { active, events } = this.activity.snapshot(id);
    const latest = new Map<string, typeof events[number]>();
    for (const event of events) {
      if (event.revision !== world.book_revision || event.location.book !== book.number || !event.location.chunk) continue;
      latest.set(`${event.kind}:${event.location.chunk}`, event);
    }
    const flagged = (kind: ActivityKind, number: number): ChunkStatus | undefined => {
      const event = latest.get(`${kind}:${number}`);
      if (event?.status !== "error") return;
      return event.severity === "warning" ? "retrying" : "failed";
    };
    const prepared = this.db.prepare(`
      SELECT ${chunkStatus}, substr(b.working, c.start + 1, min(121, c.end - c.start)) AS preview,
        (SELECT json_array(count(*) FILTER (WHERE j.value ->> '$.kind' = 'entity'),
                           count(*) FILTER (WHERE j.value ->> '$.kind' = 'relationship'))
         FROM graph_passes p, json_each(p.records) j
         WHERE p.book_id = b.id AND p.index_number = c.index_number AND p.chunk_number = c.number) AS extraction_counts
      ${chunkJoin} WHERE ${chunkScope} AND b.id = ?
        AND (? = '' OR instr(lower(substr(b.working, c.start + 1, c.end - c.start)), lower(?)) > 0)
      ORDER BY c.number`);
    const items: InspectorChunkRow[] = [];
    let matched = 0;
    const rows = prepared.iterate(id, world.index_number, bookId, query, query) as Iterable<ChunkRow & { preview: string; extraction_counts: string }>;
    for (const row of rows) {
      const chunk = this.chunk(world, row, book.number, active);
      const embedding: ChunkStatus = chunk.embedded ? "complete" :
        flagged("embedding", row.number) ?? (chunk.embedding_live ? "running" : "pending");
      const extraction: ChunkStatus = chunk.extraction === "complete" || chunk.extraction === "off" ? chunk.extraction :
        flagged("extraction", row.number) ?? (chunk.extraction === "running" ? "running" : "pending");
      const statuses = [embedding, extraction];
      const failed = statuses.includes("failed");
      if (filter === "failed" && !failed) continue;
      if (filter === "pending" && (failed || statuses.every(status => status === "complete" || status === "off"))) continue;
      if (matched++ < offset) continue;
      const [entities, relationships] = JSON.parse(row.extraction_counts) as [number, number];
      const snippet = Array.from(row.preview);
      const preview = snippet.length > 120 ? snippet.slice(0, 120).join("").trimEnd() + "…" : row.preview;
      items.push({ ...chunk, preview, embedding_status: embedding, extraction_status: extraction, entities, relationships });
      if (items.length > PAGE_SIZE) break;
    }
    return { items: items.slice(0, PAGE_SIZE), more: items.length > PAGE_SIZE };
  }

  chunkDetail(id: string, book: number, number: number, revision: number): InspectorChunkDetail {
    const world = requireWorld(this.db, id);
    if (world.book_revision !== revision) throw new RequestError("The World changed since this source was opened.", 409);
    const overlap: number = world.graph_settings ? JSON.parse(world.graph_settings).preceding_context : 0;
    const row = get<ChunkRow & { book_id: string; book_name: string; text: string; preceding: string;
      embedded_characters: number; characters: number }>(this.db, `
      SELECT ${chunkStatus}, b.id AS book_id, b.name AS book_name,
        substr(b.working, c.start + 1, c.end - c.start) AS text, ${precedingChunkTextSql} AS preceding,
        c.end - c.start AS characters, c.embed_end - c.start AS embedded_characters
      ${chunkJoin}
      LEFT JOIN chunks previous ON previous.book_id = b.id AND previous.index_number = c.index_number AND previous.number = c.number - 1
      WHERE ${chunkScope} AND b.number = ? AND c.number = ?
    `, overlap, overlap, overlap, id, world.index_number, book, number);
    if (!row) throw new RequestError("This chunk could not be found.", 404);
    const passes = all<{ pass: number; records: string }>(this.db, `
      SELECT pass, records FROM graph_passes
      WHERE book_id = ? AND index_number = ? AND chunk_number = ? ORDER BY pass
    `, row.book_id, world.index_number, number).map(pass => ({ number: pass.pass, records: JSON.parse(pass.records) as Extraction[] }));
    const status = this.chunk(world, row, book);
    return { ...status, book, book_name: row.book_name, text: row.text,
      preceding: row.started || status.extraction === "running" ? row.preceding : "",
      embedded_characters: row.embedded ? row.embedded_characters : null, characters: row.characters, passes };
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
      case "inspector-book": return this.book(id, identifier(params.get("book")), integer("offset"),
        (params.get("q") ?? "").trim().slice(0, 512), params.get("filter") ?? "all");
      case "inspector-chunk": return this.chunkDetail(id, integer("book", 1), integer("chunk", 1), integer("revision"));
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
