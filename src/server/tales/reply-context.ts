import type { RequestCaptureTrace } from "../../shared/inspectors.js";
import { CHAT_MODELS, GEMMA, GEMMA_SAMPLING } from "../../shared/models.js";
import type { ChatSettings, Persona, PromptCounts } from "../../shared/types.js";
import { InputTooLarge, LEGACY_EMBEDDING, tokenBody, type GeminiClient } from "../gemini.js";
import type { GraphContext } from "../graph/index-protocol.js";
import type { GraphIndexes } from "../graph/indexes.js";
import type { ProviderKeys } from "../keys.js";
import { pythonWorker } from "../python.js";
import { RequestError } from "../validation.js";
import type { WorldRow } from "../worlds/storage.js";

type RetrievalWorld = Pick<WorldRow, "id" | "name" | "status" | "model" | "dimensions" | "max_token_limit"
  | "max_chunk_size" | "index_number" | "book_revision">;
type HistoryEntry = {
  role: "user" | "assistant";
  content: string;
  opening: number;
  thinking: string;
  model: string | null;
  signed_parts: string | null;
  player_name?: string | null;
};
type ContextOptions = {
  databasePath: string;
  worldId: string;
  readWorld: () => WorldRow;
  keys: ProviderKeys;
  provider: GeminiClient;
  graphIndexes: GraphIndexes;
  settings: ChatSettings;
  retrievalKeys: string[];
  signal: AbortSignal;
};

export async function openReplyContext({ databasePath, worldId, readWorld, keys, provider, graphIndexes,
  settings, retrievalKeys, signal }: ContextOptions) {
  const snapshot = await openPassageSnapshot(databasePath, worldId, signal);
  const { world } = snapshot;
  let publishedGraph: ReturnType<GraphIndexes["capture"]>;
  const close = () => {
    publishedGraph?.close();
    snapshot.close();
  };

  try {
    // Pin passages and the published graph before accepting the turn.
    const currentWorld = readWorld();
    const worldChanged = currentWorld.index_number !== world.index_number
      || currentWorld.book_revision !== world.book_revision
      || currentWorld.name !== world.name;
    if (worldChanged) {
      throw new RequestError("This World changed. Send the message again.", 409);
    }
    keys.validate(settings.chat_key_ids);
    if (retrievalKeys.length) {
      keys.validate(retrievalKeys);
      publishedGraph = graphIndexes.capture(currentWorld.graph_published);
    }
  } catch (error) {
    close();
    throw error;
  }

  return {
    async build(messages: HistoryEntry[], description: string, persona: Pick<Persona, "name" | "description">) {
      const history = messages.map((message, index) => ({ ...message, turn: index + 1 })).filter(message => message.content);
      const retrievalHistory = history.filter(message => !message.opening);
      let queryVector: number[] = [];
      if (retrievalKeys.length) {
        const recentMessages = retrievalHistory.slice(-settings.messages_to_embed);
        const countQueryTokens = (text: string) => keys.retry("retrieval", retrievalKeys, signal,
          key => provider.count(world.model, key, tokenBody(text), signal));
        const embedQuery = (text: string) => keys.retry("retrieval", retrievalKeys, signal,
          key => provider.embed(world.model, world.dimensions, key, text, signal));
        queryVector = await embedRetrievalQuery(world, recentMessages, countQueryTokens, embedQuery);
      }

      let graphContext: GraphContext | undefined;
      if (publishedGraph && queryVector.length) {
        const latestUserMessage = retrievalHistory.filter(message => message.role === "user").at(-1);
        graphContext = await publishedGraph.search({
          vector: queryVector, text: latestUserMessage?.content ?? "",
          graph_budget: settings.graph_budget, graph_matches: settings.graph_matches,
          graph_hops: settings.graph_hops, graph_edges: settings.graph_edges,
        }, signal);
      }
      publishedGraph?.close();
      const request = await snapshot.build(queryVector, history, settings, { description, persona }, graphContext);
      snapshot.close();

      const chatModel = CHAT_MODELS.find(model => model.id === settings.model)!;
      let inputTokens: number | null = null;
      if (settings.input_limit < chatModel.context_limit) {
        const countRequest = { generateContentRequest: { model: `models/${settings.model}`, ...request.payload } };
        inputTokens = await keys.retry("chat", settings.chat_key_ids, signal,
          key => provider.count(settings.model, key, countRequest, signal));
        if (inputTokens > settings.input_limit) throw new InputTooLarge();
      }
      return { ...request, inputTokens };
    },
    close,
  };
}

async function embedRetrievalQuery(world: RetrievalWorld, history: HistoryEntry[],
  countTokens: (text: string) => Promise<number>, embed: (text: string) => Promise<number[]>) {
  const queryText = (messages: HistoryEntry[]) => "task: search result | query: " + messages.map(message => message.content).join("\n\n");
  if (world.model !== LEGACY_EMBEDDING) return embed(queryText(history));

  for (let firstMessage = 0; firstMessage < history.length; firstMessage++) {
    const query = queryText(history.slice(firstMessage));
    if (await countTokens(query) <= world.max_token_limit) return embed(query);
  }
  throw new InputTooLarge();
}

async function openPassageSnapshot(database: string, worldId: string, signal: AbortSignal) {
  const worker = pythonWorker("retrieve", signal);
  try {
    await worker.send({ database, worldId });
    const { world } = await worker.receive<{ world: RetrievalWorld }>();
    return {
      world,
      async build(vector: number[], history: (HistoryEntry & { turn: number })[], settings: ChatSettings,
        context: { description: string; persona: { name: string; description: string } }, graph?: GraphContext) {
        const gemma = settings.model === GEMMA;
        await worker.send({ vector, history, settings, context, graph, gemma });
        const chatRequest = await worker.receive<{ payload: { generationConfig: object }; prompt_counts: PromptCounts; trace: RequestCaptureTrace }>();
        if (gemma) Object.assign(chatRequest.payload.generationConfig, GEMMA_SAMPLING);
        return chatRequest;
      },
      close: worker.close,
    };
  } catch (error) {
    worker.close();
    throw error;
  }
}
