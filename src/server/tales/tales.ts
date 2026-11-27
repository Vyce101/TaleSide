import type { DatabaseSync } from "node:sqlite";
import { FIRST_MESSAGE, WORLD_DESCRIPTION } from "../../shared/story-defaults.js";
import type { ChatSettings, GenerationEvent, Message, Persona, PromptCounts, Swipe, Tale, TaleSummary } from "../../shared/types.js";
import type { GeminiClient } from "../gemini.js";
import type { GraphIndexes } from "../graph/indexes.js";
import { selectedKeys } from "../key-selections.js";
import type { ProviderKeys } from "../keys.js";
import type { Personas } from "../personas.js";
import type { Profiles } from "../profiles.js";
import { all, get, run, transaction } from "../sqlite.js";
import { identifier, makeId, RequestError, requiredText, whole } from "../validation.js";
import type { Worlds } from "../worlds/worlds.js";
import { openReplyContext } from "./reply-context.js";
import { createReplyStream } from "./reply-stream.js";
import { readRequestCapture, removeReplacedGraphPreview, syncMessageCaptures, trySaveRequestCapture } from "./request-capture.js";
import { searchTales } from "./search.js";

type Active = { id: string; worldId: string; controller: AbortController; stopped: boolean; message?: Message; done: Promise<void> };
type TaleRow = Omit<TaleSummary, "pinned"> & { pinned: number };
type Emit = (event: GenerationEvent) => void;
const TALE_TITLE_LIMIT = 100;
const messageFields = "id, role, content, thinking, model, status, elapsed_ms, thinking_ms, error, signed_parts, opening, swipe, player_name, player_artwork, xray_id";
type StoredSwipe = Swipe & { signed_parts: string | null; xray_id?: number | null };
type MessageRow = StoredSwipe & Pick<Message, "id" | "role" | "player_name" | "player_artwork"> & { swipe: number; opening: number };
type Rewrite = { row: MessageRow; mode: "regenerate" | "swipe" };

function swipeFrom(row: StoredSwipe): StoredSwipe {
  const { content, thinking, model, status, elapsed_ms, thinking_ms, error, signed_parts, xray_id } = row;
  return { content, thinking, model, status, elapsed_ms, thinking_ms, error, signed_parts, xray_id };
}

function publicSwipe(row: StoredSwipe): Swipe {
  const { signed_parts, xray_id, ...swipe } = swipeFrom(row);
  return { ...swipe, has_signature: Boolean(signed_parts), has_xray: xray_id != null };
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

  constructor(private db: DatabaseSync, private worlds: Worlds, private profiles: Profiles, private keys: ProviderKeys,
    private provider: GeminiClient, private graphIndexes: GraphIndexes, private databasePath: string, private personas: Personas) {}

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
    const saved = get<{ persona_id: string | null; prompt_counts: string | null }>(this.db,
      "SELECT persona_id, prompt_counts FROM tales WHERE id = ?", id)!;
    const persona = this.personas.resolve(worldId, saved.persona_id);
    return { ...summary(row), messages, persona_id: persona.id,
      prompt_counts: saved.prompt_counts ? JSON.parse(saved.prompt_counts) : undefined };
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
        elapsed_ms = ?, thinking_ms = ?, error = ?, signed_parts = ?, xray_id = ? WHERE id = ?
    `, selected, reply.content, reply.thinking, reply.model, reply.status,
    reply.elapsed_ms, reply.thinking_ms, reply.error ?? null, reply.signed_parts, reply.xray_id ?? null, id);
    syncMessageCaptures(this.db, id, swipes.map(swipe => swipe.xray_id));
  }

  messageContext(worldId: string, taleId: string, messageId: number, selected: number) {
    const row = get<MessageRow>(this.db, `
      SELECT ${messageFields} FROM tale_messages
      WHERE id = ? AND role = 'assistant' AND opening = 0
        AND tale_id = (SELECT id FROM tales WHERE id = ? AND world_id = ?)
    `, messageId, taleId, worldId);
    if (!row || row.swipe !== selected) throw new RequestError("That reply or swipe is no longer selected.", 404);
    const capture = row.xray_id == null ? undefined : readRequestCapture(this.db, row.xray_id);
    if (!capture) throw new RequestError("This reply has no saved request.", 404);
    if (capture.trace.graph_preview?.message_id !== messageId) delete capture.trace.graph_preview;
    return capture;
  }

  private touch(worldId: string, id: string) {
    const activityTimeSeconds = Date.now() / 1000;
    run(this.db, "UPDATE tales SET last_activity_at = ? WHERE id = ?", activityTimeSeconds, id);
    run(this.db, "UPDATE worlds SET last_tale_activity_at = ? WHERE id = ?", activityTimeSeconds, worldId);
  }

  changeMessage(worldId: string, id: string, action: string, input: Record<string, unknown>): Tale {
    if (this.active.has(id) && action !== "persona") throw new RequestError("Wait for the current reply to finish.", 409);
    const tale = this.detail(worldId, id);
    if (action === "persona") {
      const persona = this.personas.require(input.persona_id);
      run(this.db, "UPDATE tales SET persona_id = ? WHERE id = ?", persona.id, id);
      return this.detail(worldId, id);
    }
    const messageId = whole(input.message_id, 1, "Choose a message.");
    const messages = this.rows(id);
    const messageIndex = messages.findIndex(message => message.id === messageId);
    const message = messages[messageIndex];
    if (!message) throw new RequestError("This message could not be found.", 404);
    const isFinalMessage = messageIndex === messages.length - 1;
    const swipes = this.swipes(message);
    if (input.swipe !== message.swipe) throw new RequestError("The selected swipe changed. Reopen the Tale and try again.", 409);
    return transaction(this.db, () => {
      if (action === "branch") {
        const branchHistory = messages.slice(0, messageIndex + 1);
        return this.branchTale(tale, branchHistory, swipes);
      }
      if (action === "edit-message") {
        const content = requiredText(input.content, "Enter a message.");
        if (message.content.trim() !== content) {
          if (message.role === "assistant") {
            const swipe = swipes[message.swipe];
            swipes[message.swipe] = { ...swipe, content, signed_parts: null };
            this.writeSwipes(message.id, swipes, message.swipe);
          } else run(this.db, "UPDATE tale_messages SET content = ? WHERE id = ?", content, message.id);
        }
      } else if (action === "select-swipe" && isFinalMessage && message.role === "assistant") {
        this.writeSwipes(message.id, swipes, whole(input.position, 0, "Choose a saved swipe.", swipes.length - 1));
      } else if (action === "delete-message") {
        if (input.mode === "swipe" && isFinalMessage && swipes.length > 1) {
          swipes.splice(message.swipe, 1);
          this.writeSwipes(message.id, swipes, Math.min(message.swipe, swipes.length - 1));
        } else if (input.mode === "rewind" && !isFinalMessage) {
          run(this.db, "DELETE FROM tale_messages WHERE tale_id = ? AND id >= ?", id, message.id);
        } else if (input.mode === "message") {
          run(this.db, "DELETE FROM tale_messages WHERE id = ?", message.id);
        } else throw new RequestError("Choose what to delete.");
      } else throw new RequestError("This action is unavailable for the message.");
      this.touch(worldId, id);
      return this.detail(worldId, id);
    });
  }

  private branchTale(tale: Tale, messages: MessageRow[], branchPointSwipes: StoredSwipe[]) {
    const branchId = makeId();
    const createdAtSeconds = Date.now() / 1000;
    const titleSuffix = " (Branch)";
    const title = tale.title.slice(0, TALE_TITLE_LIMIT - titleSuffix.length) + titleSuffix;
    run(this.db, `
      INSERT INTO tales (id, world_id, title, automatic_title, created_at, last_activity_at, persona_id)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `, branchId, tale.world_id, title, createdAtSeconds, createdAtSeconds, tale.persona_id ?? null);

    const branchPointId = messages.at(-1)!.id;
    for (const message of messages) {
      const copied = run(this.db, `
        INSERT INTO tale_messages (tale_id, role, content, opening, player_name, player_artwork)
        VALUES (?, ?, ?, ?, ?, ?)
      `, branchId, message.role, message.content, message.opening, message.player_name ?? null, message.player_artwork ?? null);
      if (message.role !== "assistant") continue;

      // The branch point keeps its alternatives. Earlier turns copy only the reply the reader saw.
      const isBranchPoint = message.id === branchPointId;
      const copiedSwipes = isBranchPoint ? branchPointSwipes : [swipeFrom(message)];
      const selectedSwipe = isBranchPoint ? message.swipe : 0;
      this.writeSwipes(Number(copied.lastInsertRowid), copiedSwipes, selectedSwipe);
    }
    this.touch(tale.world_id, branchId);
    return this.detail(tale.world_id, branchId);
  }

  change(worldId: string, id: string, action: string, input: Record<string, unknown>) {
    if (action === "stop") {
      this.stop(worldId, id, identifier(input.generation_id), input.user_stopped === true);
      return;
    }
    this.detail(worldId, id);
    if (action === "rename") {
      run(this.db, "UPDATE tales SET title = ?, automatic_title = 0 WHERE id = ?",
        requiredText(input.title, "Enter a Tale title up to 100 characters.", TALE_TITLE_LIMIT), id);
    } else if (action === "pin") {
      if (typeof input.pinned !== "boolean") throw new RequestError("Pinning requires true or false.");
      run(this.db, "UPDATE tales SET pinned = ? WHERE id = ?", Number(input.pinned), id);
    } else {
      this.active.get(id)?.controller.abort();
      run(this.db, "DELETE FROM tales WHERE id = ?", id);
    }
  }

  stop(worldId: string, id: string, generationId: string, userStopped = false) {
    const active = this.active.get(id);
    if (active?.id !== generationId || active.worldId !== worldId) return;
    active.stopped ||= userStopped;
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
    const usePassages = settings.prompts.some(block => block.kind === "retrieved_passages" && block.enabled);
    const retrievalKeys = usePassages ? this.keys.validate(selectedKeys(this.db, "world_retrieval_keys", worldId)) : [];
    const missingKeys = (usePassages && !retrievalKeys.length) || !settings.chat_key_ids.length;
    const existing = get<{ world_id: string }>(this.db, "SELECT world_id FROM tales WHERE id = ?", id);
    if (existing && existing.world_id !== worldId) throw new RequestError("This Tale could not be found.", 404);
    const title = existing ? undefined : requiredText(input.title, "Enter a Tale title up to 100 characters.", TALE_TITLE_LIMIT);
    const history = this.rows(id);
    let rewrite: Rewrite | undefined;
    if (input.mode === "regenerate" || input.mode === "swipe") {
      const row = history.at(-1);
      if (!row || row.id !== input.message_id || row.swipe !== input.swipe || row.role !== "assistant" || row.opening) {
        throw new RequestError("Only the final AI reply can be regenerated.", 409);
      }
      rewrite = { row, mode: input.mode };
      history.pop();
      while (history.length && history.at(-1)!.role !== "user") history.pop();
      if (!history.length) throw new RequestError("Send a message before generating another reply.", 409);
    }
    const answer = input.mode === "answer";
    if (answer && (history.at(-1)?.role !== "user" || history.at(-1)?.id !== input.message_id)) {
      throw new RequestError("Only the final user message can be answered.", 409);
    }
    const content = rewrite || answer ? undefined : requiredText(input.content, "Enter a message.");
    const personaSelection = !existing && input.persona_id != null ? this.personas.require(input.persona_id).id : undefined;
    const openings: string[] = title === undefined ? []
      : (world.openings === null ? [FIRST_MESSAGE] : JSON.parse(world.openings)).filter((text: string) => text.trim());
    const opening = openings.length ? whole(input.opening ?? 0, 0, "Choose a saved First Message.", openings.length - 1) : 0;
    if (missingKeys) {
      if (content === undefined) throw new RequestError("A chat or retrieval key is missing.", 409);
      const persona = this.personas.resolve(worldId, existing ? this.personaSelection(id) : personaSelection);
      this.saveMessage(id, worldId, title, content, undefined, persona, openings, opening);
      emit({ type: "saved", tale: this.detail(worldId, id) });
      return Promise.resolve();
    }
    const active: Active = { id: generationId, worldId, controller: new AbortController(), stopped: false, done: Promise.resolve() };
    this.active.set(id, active);
    active.done = this.generate(id, active, { content, title, personaSelection, history, rewrite, openings, opening,
      description: world.description ?? WORLD_DESCRIPTION }, settings, retrievalKeys, emit)
      .finally(() => this.active.delete(id));
    return active.done;
  }

  private saveMessage(id: string, worldId: string, title: string | undefined, content: string, model: string | undefined,
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
      return { user: message, assistant: model ? this.insertReply(id, model) : undefined };
    });
  }

  private insertReply(id: string, model: string) {
    const created = run(this.db, "INSERT INTO tale_messages (tale_id, role, model, status) VALUES (?, 'assistant', ?, 'generating')", id, model);
    return this.publicMessage(get<MessageRow>(this.db, `SELECT ${messageFields} FROM tale_messages WHERE id = ?`, created.lastInsertRowid)!);
  }

  private async generate(id: string, active: Active, input: {
    content?: string; title?: string; personaSelection?: string; history: MessageRow[]; rewrite?: Rewrite;
    description: string; openings: string[]; opening: number;
  }, settings: ChatSettings, retrievalKeys: string[], emit: Emit) {
    const { content, title, rewrite, openings, opening, description } = input;
    const signal = active.controller.signal;
    const worldId = active.worldId;
    const started = performance.now();
    const context = await openReplyContext({
      databasePath: this.databasePath, worldId, readWorld: () => this.worlds.require(worldId), keys: this.keys,
      provider: this.provider, graphIndexes: this.graphIndexes, settings, retrievalKeys, signal,
    });
    const stream = createReplyStream(this.keys, this.provider, settings, signal, emit);
    let failure: string | undefined;
    let promptCounts: PromptCounts | undefined;
    let preparedRequest: Awaited<ReturnType<typeof context.build>> | undefined;
    let attemptedRequest = false;
    let providerPromptTokens: number | null = null;
    try {
      const persona = this.personas.resolve(worldId, title === undefined ? this.personaSelection(id) : input.personaSelection);
      let user: Message | undefined;
      let assistant: Message;
      if (rewrite) {
        this.touch(worldId, id);
        const previous = this.publicMessage(rewrite.row);
        assistant = { ...previous, content: "", thinking: "", model: settings.model, status: "generating",
          elapsed_ms: null, thinking_ms: null, error: null, has_signature: false, has_xray: false };
        if (rewrite.mode === "swipe") {
          assistant.swipe = previous.swipes!.length;
          assistant.swipes = [...previous.swipes!, publicSwipe({ ...assistant, signed_parts: null })];
        }
      } else if (content !== undefined) {
        const saved = this.saveMessage(id, worldId, title, content, settings.model, persona, openings, opening);
        user = saved.user;
        assistant = saved.assistant!;
      } else {
        assistant = transaction(this.db, () => {
          this.touch(worldId, id);
          return this.insertReply(id, settings.model);
        });
      }
      active.message = assistant;
      emit({ type: "accepted", tale: this.detail(worldId, id), user, assistant });
      const history = rewrite ? input.history : this.rows(id);
      preparedRequest = await context.build(history, description, { name: persona.name, description: persona.description });
      const { payload, prompt_counts } = preparedRequest;
      run(this.db, "UPDATE tales SET prompt_counts = ? WHERE id = ?", JSON.stringify(prompt_counts), id);
      promptCounts = prompt_counts;
      await stream.send(payload, assistant, started, () => { attemptedRequest = true; providerPromptTokens = null; },
        tokens => { providerPromptTokens = tokens; });
      assistant.status = "complete";
    } catch (error) {
      if (!active.message) throw error;
      active.message.status = active.stopped ? "stopped" : "error";
      if (!signal.aborted) failure = error instanceof Error ? error.message : "The reply could not finish.";
    } finally {
      context.close();
      const assistant = active.message;
      if (assistant) {
        const ended = performance.now();
        assistant.elapsed_ms = Math.round(ended - started);
        assistant.error = failure ?? null;
        let captureFailed = false;
        try {
          const reply = swipeFrom({ ...assistant, signed_parts: stream.signedParts() });
          transaction(this.db, () => {
            if (rewrite && reply.status === "stopped" && !reply.content) return;
            if (!get(this.db, "SELECT id FROM tale_messages WHERE id = ?", assistant.id)) return;
            if (attemptedRequest && preparedRequest && assistant.model) {
              const captureId = trySaveRequestCapture(this.db, {
                model: assistant.model,
                inputTokens: providerPromptTokens ?? preparedRequest.inputTokens,
                characters: preparedRequest.prompt_counts.total,
                payload: preparedRequest.payload,
                trace: preparedRequest.trace,
              });
              if (captureId === undefined) captureFailed = true;
              else reply.xray_id = captureId;
            }
            const swipes = rewrite ? this.swipes(rewrite.row) : [reply];
            const position = rewrite?.mode === "swipe" ? swipes.length : rewrite?.row.swipe ?? 0;
            const replacedCaptureId = swipes[position]?.xray_id;
            if (replacedCaptureId != null) removeReplacedGraphPreview(this.db, replacedCaptureId, assistant.id);
            swipes[position] = reply;
            this.writeSwipes(assistant.id, swipes, position);
          });
          const row = get<MessageRow>(this.db, `SELECT ${messageFields} FROM tale_messages WHERE id = ?`, assistant.id);
          if (row) Object.assign(assistant, this.publicMessage(row));
          if (captureFailed) assistant.xray_error = true;
        } catch {
          assistant.status = "error";
          failure = assistant.error = "The reply could not be saved.";
        }
        emit({ type: "done", message: assistant, error: failure, prompt_counts: promptCounts });
      }
    }
  }

  async close() {
    for (const reply of this.active.values()) reply.controller.abort();
    await Promise.allSettled([...this.active.values()].map(reply => reply.done));
  }
}
