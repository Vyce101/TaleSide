import type { ActivityDetail, ActivityEvent, ActivityKind, ActivityLocation, ActivityStatus, ActivityStep } from "../../shared/inspectors.js";
import type { ProviderKeyIdentity } from "../keys.js";
import { RequestError } from "../validation.js";

const MAX_TIMELINE_EVENTS = 200;
const MAX_DETAILS_PER_OUTCOME = 20;
const MAX_RETAINED_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_FIELD_BYTES = 384 * 1024;
const MAX_OPERATION_STEPS = 80;

type IndexActivitySpec = {
  worldId: string;
  bookRevision: number;
  kind: ActivityKind;
  name: string;
  location?: ActivityLocation;
};

type TextField = "input" | "output" | "thinking";
type Operation = ActivityDetail & { worldId: string; bytes: number; revision: number; keyNames: Map<string, string> };

function clipUtf8(text: string, bytes: number) {
  if (Buffer.byteLength(text) <= bytes) return text;
  let end = Math.min(bytes, text.length);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > bytes) end = Math.floor(end * 0.85);
  if (end && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
  return text.slice(0, end);
}

export class IndexActivity {
  private events: (ActivityEvent & { worldId: string })[] = [];
  private operations = new Map<number, Operation>();
  private sequence = 0;
  private retainedTextBytes = 0;

  start({ worldId, bookRevision, kind, name, location = {} }: IndexActivitySpec) {
    const started = Date.now();
    const id = ++this.sequence;
    const operation: Operation = {
      id, worldId, revision: bookRevision, kind, name, bytes: 0, keyNames: new Map(), started, ended: null, status: "running",
      location: { ...location, record: location.record === undefined ? undefined : clipUtf8(location.record, 240) },
      steps: [{ label: "Started", at: started }], input: "", output: "", thinking: "", clipped: false,
      steps_clipped: false, expired: false, error: null,
    };
    this.operations.set(id, operation);
    let retries = 0;
    this.event(operation, `${name} started`);
    return {
      step: (label: string) => this.step(operation, { label, at: Date.now() }),
      request: (label: string, key: ProviderKeyIdentity) => {
        operation.keyNames.set(key.id, key.name);
        this.step(operation, { label, at: Date.now(), key_name: key.name });
      },
      retry: (error: unknown) => {
        const at = Date.now();
        const label = `Attempt ${++retries} Failed · Retrying`;
        const reason = error instanceof RequestError ? `${error.status} · ${error.message}` :
          error instanceof Error ? error.message : "The request failed.";
        this.step(operation, { label, at, severity: "warning", error: clipUtf8(reason, 768) });
        this.event(operation, label, "error", at, "warning");
      },
      input: (text: string) => this.set(operation, "input", text, false),
      output: (text: string, thinking = false) => this.set(operation, thinking ? "thinking" : "output", text, true),
      resetOutput: () => {
        this.set(operation, "output", "", false);
        this.set(operation, "thinking", "", false);
      },
      finish: (status: Exclude<ActivityStatus, "running">, error: string | null = null) => {
        if (operation.ended !== null || !this.operations.has(operation.id)) return;
        operation.ended = Date.now();
        operation.status = status;
        operation.error = error === null ? null : clipUtf8(error, 4096);
        const label = { complete: "Completed", error: "Failed", stopped: "Stopped" }[status];
        this.step(operation, { label, at: operation.ended, severity: status === "error" ? "error" : undefined });
        this.event(operation, `${name} ${label.toLowerCase()}`);
        this.trimCompletedOperations();
      },
    };
  }

  async track<T>(spec: IndexActivitySpec, signal: AbortSignal, work: (activity: IndexActivityRecorder) => Promise<T>): Promise<T> {
    const activity = this.start(spec);
    try {
      const value = await work(activity);
      activity.finish("complete");
      return value;
    } catch (error) {
      activity.finish(signal.aborted ? "stopped" : "error", signal.aborted ? null :
        error instanceof Error ? error.message : "Indexing operation failed.");
      throw error;
    }
  }

  private step(operation: Operation, step: ActivityStep) {
    if (operation.steps.length >= MAX_OPERATION_STEPS) {
      operation.steps.splice(1, 1);
      operation.steps_clipped = true;
    }
    operation.steps.push(step);
  }

  private event(operation: Operation, name: string, status = operation.status, at = operation.ended ?? operation.started,
    severity: ActivityEvent["severity"] = status === "error" ? "error" : undefined) {
    if (!this.operations.has(operation.id)) return;
    const { kind, location, started, worldId, revision } = operation;
    this.events.push({ id: ++this.sequence, operation: operation.id, worldId, kind, status, location, name, revision,
      operation_name: operation.name, severity, at, elapsed: status === "running" ? null : at - started });
    if (this.events.length > MAX_TIMELINE_EVENTS) this.events.shift();
  }

  private evict(operation: Operation) {
    this.retainedTextBytes -= operation.bytes;
    operation.bytes = 0;
    operation.input = "";
    operation.output = "";
    operation.thinking = "";
    operation.expired = true;
  }

  private trimCompletedOperations(additionalBytes = 0) {
    const completed = [...this.operations.values()].filter(op => op.ended !== null)
      .sort((a, b) => b.ended! - a.ended! || b.id - a.id);
    let nonErrorDetails = 0;
    let errorDetails = 0;
    for (const op of completed) {
      const count = op.status === "error" ? ++errorDetails : ++nonErrorDetails;
      if (count > MAX_DETAILS_PER_OUTCOME && !op.expired) this.evict(op);
    }
    // Evict completed request text oldest first. Keep timeline entries readable after eviction.
    for (const op of completed.reverse()) {
      if (this.retainedTextBytes + additionalBytes <= MAX_RETAINED_TEXT_BYTES) break;
      if (!op.expired) this.evict(op);
    }
    const first = this.events[0]?.id ?? 0;
    const retained = new Set(this.events.map(event => event.operation));
    for (const op of completed) {
      if (op.id < first && !retained.has(op.id)) {
        this.evict(op);
        this.operations.delete(op.id);
      }
    }
  }

  private set(op: Operation, field: TextField, text: string, append: boolean) {
    if (!this.operations.has(op.id) || op.ended !== null) return;
    const old = op[field];
    const oldBytes = Buffer.byteLength(old);
    const desired = Math.min(MAX_FIELD_BYTES, Buffer.byteLength(text) + (append ? oldBytes : 0));
    if (this.retainedTextBytes - oldBytes + desired > MAX_RETAINED_TEXT_BYTES) this.trimCompletedOperations(desired - oldBytes);
    const capacity = Math.max(0, Math.min(MAX_FIELD_BYTES, MAX_RETAINED_TEXT_BYTES - this.retainedTextBytes + oldBytes));
    const prefix = append ? old : "";
    const suffix = clipUtf8(text, Math.max(0, capacity - Buffer.byteLength(prefix)));
    const value = prefix + suffix;
    op.clipped ||= suffix.length !== text.length;
    op[field] = value;
    const delta = Buffer.byteLength(value) - oldBytes;
    op.bytes += delta;
    this.retainedTextBytes += delta;
  }

  snapshot(worldId: string) {
    const events = this.events.filter(event => event.worldId === worldId).map(({ worldId: _world, ...event }) => {
      const names = this.operations.get(event.operation)?.keyNames;
      if (!names?.size) return event;
      const keys = names.size === 1 ? { count: 1, name: names.values().next().value } : { count: names.size };
      return { ...event, keys };
    });
    const active = [...this.operations.values()].filter(op => op.worldId === worldId && op.status === "running")
      .map(({ id, name, kind, location, started }) => ({ id, name, kind, location, started }));
    return { events, active };
  }

  detail(worldId: string, id: number): ActivityDetail | undefined {
    const op = this.operations.get(id);
    if (!op || op.worldId !== worldId) return;
    const { worldId: _world, bytes: _bytes, keyNames: _keys, ...detail } = op;
    return detail;
  }

  discard(worldId: string) {
    this.events = this.events.filter(event => event.worldId !== worldId);
    for (const [id, op] of this.operations) {
      if (op.worldId !== worldId) continue;
      this.evict(op);
      this.operations.delete(id);
    }
  }
}

export type IndexActivityRecorder = Omit<ReturnType<IndexActivity["start"]>, "finish">;
