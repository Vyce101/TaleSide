import { FIRST_MESSAGE } from "../shared/story-defaults.js";
import { Personas } from "./personas.js";
import type { ChatSettings, GenerationEvent, Message, Persona, Swipe, Tale, TaleSummary } from "../shared/types.js";
import { all, get, run, selectedKeys, transaction } from "./database.js";
import { CHAT_MODEL, InputTooLarge, tokenBody, type GeminiClient, type Part } from "./gemini.js";
import { Profiles } from "./profiles.js";
import { openRetrieval, retrievalVector, type HistoryEntry } from "./retrieval.js";
import { identifier, RequestError, requiredText, whole } from "./validation.js";
import { searchTales } from "./tale-search.js";
import { Worlds } from "./worlds.js";

type Active = { id: string; worldId: string; controller: AbortController; stopped: boolean; message?: Message; done: Promise<void> };
type TaleRow = Omit<TaleSummary, "pinned"> & { pinned: number };
type Emit = (event: GenerationEvent) => void;
const messageFields = "id, role, content, thinking, model, status, elapsed_ms, thinking_ms, error, signed_parts, opening, swipe, player_name, player_artwork";
type StoredSwipe = Swipe & { signed_parts: string | null };
type MessageRow = StoredSwipe & Pick<Message, "id" | "role" | "player_name" | "player_artwork"> & { swipe: number; opening: number };
function swipeFrom(row: StoredSwipe): StoredSwipe {
  const { content, thinking, model, status, elapsed_ms, thinking_ms, error, signed_parts } = row;
  return { content, thinking, model, status, elapsed_ms, thinking_ms, error, signed_parts };
}

function publicSwipe(row: StoredSwipe): Swipe {
  const { signed_parts, ...swipe } = swipeFrom(row);
  return { ...swipe, has_signature: Boolean(signed_parts) };
}
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
    private databasePath: string, private personas: Personas) {}

  private get db() { return this.worlds.db; }

  list() {
    return all<TaleRow>(this.db, summarySql + " ORDER BY t.pinned DESC, coalesce(t.last_activity_at, t.created_at) DESC, t.rowid DESC")
      .map(summary);
  }

  search(query: string, worldId: string | null) {
    return searchTales<TaleRow>(this.db, summarySql, query, worldId).map(row => ({ ...row, pinned: Boolean(row.pinned) }));
  }

  detail(worldId: string, id: string): Tale {
    const row = get<TaleRow>(this.db, summarySql + " WHERE t.world_id = ? AND t.id = ?", worldId, id);
    if (!row) throw new RequestError("This Tale could not be found.", 404);
    const messages = this.rows(id).map(message => this.publicMessage(message));
    const running = this.active.get(id)?.message;
    if (running?.status === "generating" && messages.at(-1)?.id === running.id) messages[messages.length - 1] = { ...running };
    const persona = this.personas.resolve(worldId, this.personaSelection(id));
    return { ...summary(row), messages, persona_id: persona.id };
  }

  private personaSelection(id: string) {
    return get<{ persona_id: string | null }>(this.db, "SELECT persona_id FROM tales WHERE id = ?", id)?.persona_id;
  }

  private rows(id: string) {
    return all<MessageRow>(this.db, `SELECT ${messageFields} FROM tale_messages WHERE tale_id = ? ORDER BY id`, id);
  }

  private swipes(row: MessageRow): StoredSwipe[] {
    const saved = all<{ reply: string }>(this.db, "SELECT reply FROM tale_swipes WHERE message_id = ? ORDER BY position", row.id);
    return saved.length ? saved.map(({ reply }) => JSON.parse(reply)) : [swipeFrom(row)];
  }

  private publicMessage(row: MessageRow): Message {
    const { id, role, swipe, opening, player_name, player_artwork } = row;
    return { id, role, swipe, opening: Boolean(opening), player_name, player_artwork, ...publicSwipe(row),
      swipes: role === "assistant" ? this.swipes(row).map(publicSwipe) : undefined };
  }

  private writeSwipes(id: number, swipes: StoredSwipe[], selected: number) {
    const reply = swipes[selected];
    run(this.db, "DELETE FROM tale_swipes WHERE message_id = ?", id);
    if (swipes.length > 1) {
      const insert = this.db.prepare("INSERT INTO tale_swipes VALUES (?, ?, ?)");
      swipes.forEach((swipe, index) => insert.run(id, index, JSON.stringify(swipe)));
    }
    run(this.db, `
      UPDATE tale_messages SET swipe = ?, content = ?, thinking = ?, model = ?, status = ?,
        elapsed_ms = ?, thinking_ms = ?, error = ?, signed_parts = ? WHERE id = ?
    `, selected, reply.content, reply.thinking, reply.model, reply.status,
    reply.elapsed_ms, reply.thinking_ms, reply.error ?? null, reply.signed_parts, id);
  }

  private touch(worldId: string, id: string) {
    const now = Date.now() / 1000;
    run(this.db, "UPDATE tales SET last_activity_at = ? WHERE id = ?", now, id);
    run(this.db, "UPDATE worlds SET last_tale_activity_at = ? WHERE id = ?", now, worldId);
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
    const settings = this.profiles.validate(input.settings);
    const retrievalKeys = this.worlds.keys.validate(selectedKeys(this.db, "world_retrieval_keys", worldId));
    if (!retrievalKeys.length || !settings.chat_key_ids.length) throw new RequestError("A chat or retrieval key is missing.", 409);
    const existing = get<{ world_id: string }>(this.db, "SELECT world_id FROM tales WHERE id = ?", id);
    if (existing && existing.world_id !== worldId) throw new RequestError("This Tale could not be found.", 404);
    const title = existing ? undefined : requiredText(input.title, "Enter a Tale title up to 100 characters.", 100);
    const content = requiredText(input.content, "Enter a message.");
    const personaSelection = !existing && input.persona_id != null ? this.personas.require(input.persona_id).id : undefined;
    const openings: string[] = title === undefined ? []
      : (world.openings === null ? [FIRST_MESSAGE] : JSON.parse(world.openings)).filter((text: string) => text.trim());
    const opening = openings.length ? whole(input.opening ?? 0, 0, "Choose a saved First Message.", openings.length - 1) : 0;
    const active: Active = { id: generationId, worldId, controller: new AbortController(), stopped: false, done: Promise.resolve() };
    this.active.set(id, active);
    active.done = this.generate(id, active, { content, title, personaSelection, openings, opening }, settings, retrievalKeys, emit)
      .finally(() => this.active.delete(id));
    return active.done;
  }

  private saveMessage(id: string, worldId: string, title: string | undefined, content: string, model: string,
    persona: Persona, openings: string[], opening: number) {
    return transaction(this.db, () => {
      if (title !== undefined) {
        run(this.db, "INSERT INTO tales (id, world_id, title, automatic_title, created_at, persona_id) VALUES (?, ?, ?, 0, ?, ?)",
          id, worldId, title, Date.now() / 1000, persona.id);
        if (openings.length) {
          const row = run(this.db, "INSERT INTO tale_messages (tale_id, role, opening) VALUES (?, 'assistant', 1)", id);
          this.writeSwipes(Number(row.lastInsertRowid), openings.map(content => ({
            content, thinking: "", model: null, status: "complete", elapsed_ms: null, thinking_ms: null, signed_parts: null,
          })), opening);
        }
      } else if (!get(this.db, "SELECT 1 FROM tales WHERE id = ? AND world_id = ?", id, worldId)) {
        throw new RequestError("This Tale could not be found.", 404);
      }
      this.touch(worldId, id);
      const user = run(this.db, `
        INSERT INTO tale_messages (tale_id, role, content, player_name, player_artwork) VALUES (?, 'user', ?, ?, ?)
      `, id, content, persona.name, persona.artwork);
      const message = this.publicMessage(get<MessageRow>(this.db,
        `SELECT ${messageFields} FROM tale_messages WHERE id = ?`, user.lastInsertRowid)!);
      return { user: message, assistant: this.insertReply(id, model) };
    });
  }

  private insertReply(id: string, model: string) {
    const created = run(this.db, "INSERT INTO tale_messages (tale_id, role, model, status) VALUES (?, 'assistant', ?, 'generating')", id, model);
    return this.publicMessage(get<MessageRow>(this.db, `SELECT ${messageFields} FROM tale_messages WHERE id = ?`, created.lastInsertRowid)!);
  }

  private async *chatWithRetry(settings: ChatSettings, payload: object, signal: AbortSignal) {
    for (const { key, last } of this.worlds.keys.attempts("chat", settings.chat_key_ids, signal)) {
      let started = false;
      const pending: Part[] = [];
      try {
        for await (const part of this.provider.chat(settings.model, key, payload, signal)) {
          signal.throwIfAborted();
          if (!started && !part.text) { pending.push(part); continue; }
          if (!started) {
            started = true;
            yield* pending;
          }
          yield part;
        }
        signal.throwIfAborted();
        if (!started) yield* pending;
        return;
      } catch (error) {
        if (last || started || signal.aborted) throw error;
      }
    }
  }

  private async generate(id: string, active: Active, input: {
    content: string; title?: string; personaSelection?: string;
    openings: string[]; opening: number;
  }, settings: ChatSettings, retrievalKeys: string[], emit: Emit) {
    const { content, title, openings, opening } = input;
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
      const persona = this.personas.resolve(worldId, title === undefined ? this.personaSelection(id) : input.personaSelection);
      const { user, assistant } = this.saveMessage(id, worldId, title, content, settings.model, persona, openings, opening);
      active.message = assistant;
      emit({ type: "accepted", tale: this.detail(worldId, id), user, assistant });
      const history: HistoryEntry[] = this.rows(id).filter(row => row.content);
      const retrievalHistory = this.rows(id).filter(row => row.content && !row.opening);
      const keys = this.worlds.keys;
      const query = await retrievalVector(world, retrievalHistory.slice(-settings.messages_to_embed),
        text => keys.retry("retrieval", retrievalKeys, signal, key => this.provider.count(world.model, key, tokenBody(text), signal)),
        text => keys.retry("retrieval", retrievalKeys, signal, key => this.provider.embed(world.model, world.dimensions, key, text, signal)));
      const payload = await snapshot.build(query, history, settings);
      snapshot.close();
      if (settings.input_limit < CHAT_MODEL.context_limit) {
        const full = { generateContentRequest: { model: `models/${settings.model}`, ...payload } };
        const tokens = await keys.retry("chat", settings.chat_key_ids, signal, key => this.provider.count(settings.model, key, full, signal));
        if (tokens > settings.input_limit) throw new InputTooLarge();
      }
      for await (const part of this.chatWithRetry(settings, payload, signal)) {
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
      if (!signal.aborted) failure = error instanceof Error ? error.message : "The reply could not finish.";
    } finally {
      snapshot.close();
      const assistant = active.message;
      if (assistant) {
        const ended = performance.now();
        assistant.elapsed_ms = Math.round(ended - started);
        assistant.error = failure ?? null;
        try {
          const reply = swipeFrom({ ...assistant, signed_parts: signedParts.some(part => part.thoughtSignature)
            ? JSON.stringify(signedParts) : null });
          transaction(this.db, () => this.writeSwipes(assistant.id, [reply], 0));
          const row = get<MessageRow>(this.db, `SELECT ${messageFields} FROM tale_messages WHERE id = ?`, assistant.id);
          if (row) Object.assign(assistant, this.publicMessage(row));
        } catch {
          assistant.status = "error";
          failure = assistant.error = "The reply could not be saved.";
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
