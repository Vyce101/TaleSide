import type { ChatSettings, GenerationEvent, Message, Tale, TaleSummary } from "../shared/types.js";
import { all, get, run, selectedKeys, transaction } from "./database.js";
import { CHAT_MODEL, InputTooLarge, type GeminiClient, type Part } from "./gemini.js";
import { Profiles } from "./profiles.js";
import { openRetrieval, retrievalVector, type HistoryEntry } from "./retrieval.js";
import { identifier, RequestError, requiredText } from "./validation.js";
import { Worlds } from "./worlds.js";

type Active = { id: string; worldId: string; controller: AbortController; stopped: boolean; message?: Message; done: Promise<void> };
type TaleRow = Omit<TaleSummary, "pinned"> & { pinned: number };
type Emit = (event: GenerationEvent) => void;
const messageFields = "id, role, content, thinking, model, status, elapsed_ms, thinking_ms";
const summarySql = `
  SELECT t.id, t.world_id, t.title, t.pinned, t.created_at, t.last_activity_at,
    (SELECT count(*) FROM tale_messages WHERE tale_id = t.id AND (content <> '' OR thinking <> '')) AS message_count,
    coalesce(substr((SELECT content FROM tale_messages WHERE tale_id = t.id AND content <> '' ORDER BY id DESC LIMIT 1), 1, 400), '') AS content
  FROM tales t
`;

function summary(row: TaleRow): TaleSummary { return { ...row, pinned: Boolean(row.pinned) }; }

export class Tales {
  private active = new Map<string, Active>();

  constructor(private worlds: Worlds, private profiles: Profiles, private provider: GeminiClient,
    private databasePath: string) {}

  private get db() { return this.worlds.db; }

  list() {
    return all<TaleRow>(this.db, summarySql + " ORDER BY t.pinned DESC, coalesce(t.last_activity_at, t.created_at) DESC, t.rowid DESC")
      .map(summary);
  }

  detail(worldId: string, id: string): Tale {
    const row = get<TaleRow>(this.db, summarySql + " WHERE t.world_id = ? AND t.id = ?", worldId, id);
    if (!row) throw new RequestError("This Tale could not be found.", 404);
    const messages = all<Message>(this.db, `SELECT ${messageFields} FROM tale_messages WHERE tale_id = ? ORDER BY id`, id);
    const running = this.active.get(id)?.message;
    if (running && messages.at(-1)?.id === running.id) messages[messages.length - 1] = { ...running };
    return { ...summary(row), messages };
  }

  change(worldId: string, id: string, action: string, input: Record<string, unknown>) {
    if (action === "stop") {
      this.stop(worldId, id, identifier(input.generation_id), input.user_stopped === true);
      return;
    }
    this.detail(worldId, id);
    if (action === "rename") {
      run(this.db, "UPDATE tales SET title = ?, automatic_title = 0 WHERE id = ?",
        requiredText(input.title, "Enter a Tale title up to 100 characters.", 100), id);
    } else if (action === "pin") {
      if (typeof input.pinned !== "boolean") throw new RequestError("Pinning requires true or false.");
      run(this.db, "UPDATE tales SET pinned = ? WHERE id = ?", Number(input.pinned), id);
    } else {
      this.active.get(id)?.controller.abort();
      run(this.db, "DELETE FROM tales WHERE id = ?", id);
    }
  }

  stop(worldId: string, id: string, generationId: string, stopped = false) {
    const active = this.active.get(id);
    if (active?.id !== generationId || active.worldId !== worldId) return;
    active.stopped ||= stopped;
    active.controller.abort();
  }

  discardWorld(worldId: string) {
    for (const active of this.active.values()) {
      if (active.worldId === worldId) active.controller.abort();
    }
  }

  begin(worldId: string, id: string, input: Record<string, unknown>, emit: Emit) {
    const world = this.worlds.require(worldId);
    if (this.active.has(id)) throw new RequestError("This Tale is already generating.", 409);
    if (!this.worlds.canPlay(world)) throw new RequestError("Waiting for the first indexed passage.", 409);
    const generationId = identifier(input.generation_id);
    const content = requiredText(input.content, "Enter a message.");
    const settings = this.profiles.validate(input.settings);
    const retrievalKeys = this.worlds.keys.validate(selectedKeys(this.db, "world_retrieval_keys", worldId));
    if (!retrievalKeys.length || !settings.chat_key_ids.length) throw new RequestError("A chat or retrieval key is missing.", 409);
    const existing = get<{ world_id: string }>(this.db, "SELECT world_id FROM tales WHERE id = ?", id);
    if (existing && existing.world_id !== worldId) throw new RequestError("This Tale could not be found.", 404);
    const title = existing ? undefined : requiredText(input.title, "Enter a Tale title up to 100 characters.", 100);
    const active: Active = { id: generationId, worldId, controller: new AbortController(), stopped: false, done: Promise.resolve() };
    this.active.set(id, active);
    active.done = this.generate(id, active, content, title, settings, retrievalKeys, emit)
      .finally(() => this.active.delete(id));
    return active.done;
  }

  private saveMessage(id: string, worldId: string, title: string | undefined, content: string, model: string) {
    return transaction(this.db, () => {
      const now = Date.now() / 1000;
      if (title !== undefined) run(this.db, "INSERT INTO tales (id, world_id, title, automatic_title, created_at) VALUES (?, ?, ?, 0, ?)",
        id, worldId, title, now);
      else if (!get(this.db, "SELECT 1 FROM tales WHERE id = ? AND world_id = ?", id, worldId)) {
        throw new RequestError("This Tale could not be found.", 404);
      }
      run(this.db, "UPDATE tales SET last_activity_at = ? WHERE id = ?", now, id);
      run(this.db, "UPDATE worlds SET last_tale_activity_at = ? WHERE id = ?", now, worldId);
      const user = run(this.db, "INSERT INTO tale_messages (tale_id, role, content) VALUES (?, 'user', ?)", id, content);
      const assistant = run(this.db, "INSERT INTO tale_messages (tale_id, role, model, status) VALUES (?, 'assistant', ?, 'generating')", id, model);
      return [user, assistant].map(row => get<Message>(this.db, `SELECT ${messageFields} FROM tale_messages WHERE id = ?`, row.lastInsertRowid)!) as [Message, Message];
    });
  }

  private async generate(id: string, active: Active, content: string, title: string | undefined, settings: ChatSettings,
    retrievalKeys: string[], emit: Emit) {
    const signal = active.controller.signal;
    const worldId = active.worldId;
    const started = performance.now();
    const snapshot = await openRetrieval(this.databasePath, worldId, signal);
    const signedParts: Part[] = [];
    let failure: string | undefined;
    try {
      const { world } = snapshot;
      const current = this.worlds.require(worldId);
      if (current.index_number !== world.index_number || current.book_revision !== world.book_revision || current.name !== world.name) {
        throw new RequestError("This World changed. Send the message again.", 409);
      }
      this.worlds.keys.validate(settings.chat_key_ids);
      this.worlds.keys.validate(retrievalKeys);
      const history = all<HistoryEntry>(this.db, `
        SELECT role, content, model, signed_parts FROM tale_messages WHERE tale_id = ? AND content <> '' ORDER BY id
      `, id);
      const [user, assistant] = this.saveMessage(id, worldId, title, content, settings.model);
      active.message = assistant;
      emit({ type: "accepted", tale: this.detail(worldId, id), user, assistant });
      history.push({ role: "user", content });
      const key = (purpose: "retrieval" | "chat") => {
        signal.throwIfAborted();
        return this.worlds.keys.next(purpose, purpose === "retrieval" ? retrievalKeys : settings.chat_key_ids);
      };
      const query = await retrievalVector(this.provider, world, () => key("retrieval"), history.slice(-settings.messages_to_embed), signal);
      const payload = await snapshot.build(query, history, settings);
      snapshot.close();
      if (settings.input_limit < CHAT_MODEL.context_limit) {
        const full = { generateContentRequest: { model: `models/${settings.model}`, ...payload } };
        if (await this.provider.count(settings.model, key("chat"), full, signal) > settings.input_limit) throw new InputTooLarge();
      }
      for await (const part of this.provider.chat(settings.model, key("chat"), payload, signal)) {
        signal.throwIfAborted();
        if (typeof part.text === "string" && part.text) {
          if (part.thought) {
            assistant.thinking_ms = Math.round(performance.now() - started);
            assistant.thinking += part.text;
            emit({ type: "thinking", text: part.text, thinking_ms: assistant.thinking_ms });
          } else {
            assistant.content += part.text;
            emit({ type: "reply", text: part.text });
          }
        }
        if (!part.thought && settings.thought_signatures && typeof part.text === "string") {
          if (typeof part.thoughtSignature === "string" && part.thoughtSignature) {
            signedParts.push({ text: part.text, thoughtSignature: part.thoughtSignature });
          } else if (part.text) {
            const prior = signedParts.at(-1);
            if (prior && !prior.thoughtSignature) prior.text += part.text;
            else signedParts.push({ text: part.text });
          }
        }
      }
      signal.throwIfAborted();
      assistant.status = "complete";
    } catch (error) {
      if (!active.message) throw error;
      active.message.status = active.stopped ? "stopped" : "error";
      if (!signal.aborted) failure = error instanceof InputTooLarge ? error.message : "The reply could not finish.";
    } finally {
      snapshot.close();
      const assistant = active.message;
      if (assistant) {
        const ended = performance.now();
        assistant.elapsed_ms = Math.round(ended - started);
        try {
          run(this.db, `
            UPDATE tale_messages SET content = ?, thinking = ?, status = ?, signed_parts = ?, elapsed_ms = ?, thinking_ms = ?
            WHERE tale_id = ? AND id = ?
          `, assistant.content, assistant.thinking, assistant.status,
          signedParts.some(part => part.thoughtSignature) ? JSON.stringify(signedParts) : null,
          assistant.elapsed_ms, assistant.thinking_ms, id, assistant.id);
        } catch {
          assistant.status = "error";
          failure = "The reply could not be saved.";
        }
        emit({ type: "done", message: assistant, error: failure });
      }
    }
  }

  async close() {
    for (const reply of this.active.values()) reply.controller.abort();
    await Promise.allSettled([...this.active.values()].map(reply => reply.done));
  }
}
