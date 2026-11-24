import { GEMMA, GEMMA_SAMPLING } from "../../shared/models.js";
import type { GraphSettings } from "../../shared/types.js";

import { ENTITY_TYPES, entityIdentity, normalizedName, type Endpoint, type EntityType, type Extraction } from "./records.js";

const COMPLETE = "<|COMPLETE|>";
const FIELD = "<|>";
export const MAX_GRAPH_ATTEMPTS = 3;

function tuple(record: Extraction) {
  const values = record.kind === "entity" ? ['"entity"', record.name, record.type, record.description]
    : ['"relationship"', record.source.name, record.source.type, record.target.name, record.target.type, record.description, record.strength];
  return "##\n(" + values.join(FIELD) + ")";
}

function recordIdentity(record: Extraction) {
  const description = record.description.replace(/\s+/gu, " ").trim();
  return JSON.stringify(record.kind === "entity" ? [entityIdentity(record), description]
    : [entityIdentity(record.source), entityIdentity(record.target), description]);
}

export function newRecords(records: Extraction[], previous: Extraction[]) {
  const known = new Set(previous.map(recordIdentity));
  return records.filter(record => {
    const id = recordIdentity(record);
    if (known.has(id)) return false;
    known.add(id);
    return true;
  });
}

function completedBody(text: string) {
  const cleaned = text.trim();
  if (cleaned === COMPLETE) return "";
  const end = cleaned.lastIndexOf("\n");
  if (end < 0 || cleaned.slice(end + 1).trim() !== COMPLETE) {
    throw new Error("The extraction model response ended before <|COMPLETE|>.");
  }
  return cleaned.slice(0, end).trim();
}

function endpoint(name: string, type: string): Endpoint {
  if (!normalizedName(name) || !ENTITY_TYPES.includes(type as EntityType)) throw new Error("The extraction returned an invalid entity.");
  return { name, type: type as EntityType };
}

export function parseExtraction(text: string, previous: Extraction[]) {
  const body = completedBody(text);
  if (!body) return [];
  const records: Extraction[] = body.split(/^##[ \t]*\r?$/m).slice(1).map(entry => {
    const row = entry.trim();
    if (!row.startsWith("(") || !row.endsWith(")")) throw new Error("The extraction returned an invalid record.");
    const [kind, ...data] = row.slice(1, -1).split(FIELD).map(value => value.trim());
    if (kind === '"entity"' && data.length === 3 && data[2]) {
      return { kind: "entity", ...endpoint(data[0], data[1]), description: data[2] };
    }
    if (kind === '"relationship"' && data.length === 6 && data[4] && /^(?:[1-9]|10)$/.test(data[5])) {
      return { kind: "relationship", source: endpoint(data[0], data[1]), target: endpoint(data[2], data[3]),
        description: data[4], strength: Number(data[5]) };
    }
    throw new Error("The extraction returned an invalid record.");
  });
  if (!/^##[ \t]*\r?\n/.test(body) || !records.length) throw new Error("The extraction returned an invalid record.");
  const entities = new Set([...previous, ...records].flatMap(record =>
    record.kind === "entity" ? [JSON.stringify([record.name, record.type])] : []));
  for (const record of records) {
    if (record.kind === "relationship" && ![record.source, record.target].every(item => entities.has(JSON.stringify([item.name, item.type])))) {
      throw new Error("A relationship refers to an entity that was not extracted from this chunk.");
    }
  }
  return records;
}

const example = `Text:
The harbor masters of Vane Port taxed every hull except the Ashen Guild's galleys, a privilege bought during the Salt War. Corvin kept his forged Guild seal tucked inside his boot—if the Watch caught him carrying it, the penalty for counterfeit sigils was branding, though half the dockworkers whispered the Guild itself had stopped paying the Watch captain altogether.

Output:
##
("entity"<|>VANE PORT<|>LOCATION<|>A taxed harbor city patrolled by the Watch. Harbor masters collect hull taxes on arriving ships.)
##
("entity"<|>ASHEN GUILD<|>FACTION/GROUP<|>A maritime organization whose galleys are exempt from Vane Port's hull tax due to a deal from the Salt War. Dockworkers whisper the Guild has stopped paying bribes to the Watch captain.)
##
("entity"<|>SALT WAR<|>EVENT<|>A past conflict during which the Ashen Guild purchased tax-exempt status in Vane Port.)
##
("entity"<|>CORVIN<|>CHARACTER<|>Possesses a forged Ashen Guild seal hidden in his boot; risks branding if caught by the Watch. The seal is counterfeit.)
##
("entity"<|>THE WATCH<|>FACTION/GROUP<|>Enforces harbor laws in Vane Port, including branding anyone caught with counterfeit Guild sigils.)
##
("entity"<|>GUILD SEAL<|>ITEM<|>An Ashen Guild sigil; Corvin carries a forged copy hidden in his boot. Carrying a counterfeit carries a legal penalty of branding.)
##
("entity"<|>COUNTERFEIT SIGIL LAW<|>SYSTEM_OR_WORLD_RULE<|>In Vane Port, carrying a forged Guild seal is punished by branding.)
##
("relationship"<|>ASHEN GUILD<|>FACTION/GROUP<|>VANE PORT<|>LOCATION<|>Exempt from Vane Port's hull taxes since the Salt War.<|>8)
##
("relationship"<|>CORVIN<|>CHARACTER<|>GUILD SEAL<|>ITEM<|>Corvin hides a forged Ashen Guild seal in his boot.<|>7)
##
("relationship"<|>THE WATCH<|>FACTION/GROUP<|>ASHEN GUILD<|>FACTION/GROUP<|>Dockworkers believe the Ashen Guild stopped bribing the Watch captain.<|>5)
##
("relationship"<|>CORVIN<|>CHARACTER<|>THE WATCH<|>FACTION/GROUP<|>Corvin would be branded by the Watch if they discovered his forged seal.<|>7)
<|COMPLETE|>`;

export function extractionPrompt(context: string, excerpt: string, alreadyExtracted?: Extraction[]) {
  const prompt = `#### Goal
Given a fiction excerpt and a list of entity types, extract all story-relevant entities and relationships so a roleplay Game Master can accurately simulate the setting, characters, rules, and hidden vs. public knowledge.

#### Entity Types
${ENTITY_TYPES.join(", ")}

#### Steps
1. Identify all entities in the excerpt. For each entity, extract:
- entity_name: Canonical name of the entity, capitalized (use the most recognizable full name or title). Never output I, Me, He, She, Narrator, Protagonist or any other ambiguous name that could result in entity resolution combining different entities.
- entity_type: One of the entity types.
- entity_description: Concrete, story-useful description covering aspects such as looks, role, atmosphere, purpose, how it works, what caused it, what changed afterwards, and whether it is a rumor, public knowledge or a secret. Only state information in this chunk. Do not use your internal knowledge of the universe.

2. Identify all connected pairs of entities from step 1. For each relationship, extract:
- source_entity and source_type: Exact entity_name and entity_type from step 1.
- target_entity and target_type: Exact entity_name and entity_type from step 1.
- relationship_description: Specific explanation of how they are connected. Only state information in this chunk.
- relationship_strength: Integer 1–10 indicating how consequential this tie is to the entities.

3. Put ## on its own line before each record. Use the field order and delimiters in the example. Begin immediately with ## (or <|COMPLETE|> if nothing is found). End with <|COMPLETE|> on its own line.

#### Example
${example}

#### Read-Only Preceding Context
From the end of the previous chunk. DO NOT extract from this. Use it ONLY to resolve pronouns, speakers, and ongoing context in the Excerpt below.
${context}

#### Excerpt
${excerpt}`;
  if (!alreadyExtracted) return prompt;
  return `${prompt}

#### Already Extracted
${alreadyExtracted.map(tuple).join("\n")}

Check if any story-relevant characters, locations, factions or groups, world rules or systems, items, events, or relationships are missing from Already Extracted.
Add ONLY missing entries. Do not repeat already extracted entries. Use the exact existing entity names and types for new relationships, and end with "<|COMPLETE|>".
If nothing is missing, output ONLY "<|COMPLETE|>".`;
}

export function consolidationPrompt(kind: string, name: string, input: string) {
  return `#### Goal
You are consolidating notes extracted from multiple sections of a fictional world about a single ${kind} ("${name}").
Combine the descriptions below into one clean, accurate reference dossier for a roleplay Game Master.

#### Rules
1. Preserve concrete details such as traits, speech or behavioral habits, abilities, limitations, possessions, alliances, enmities, and causal reasons.
2. Keep chronological progression intact. If a status, allegiance, or location changes across the source anchors, describe the initial state first and clearly mark later developments. Never treat an end-of-story outcome as true from the beginning. Use the supplied B1:C1-style tags as chronological anchors.
3. Resolve direct duplicates cleanly without dropping rare, specific details such as an injury, debt, or rule exception.
4. Do not invent facts or moralize.
5. Output ONLY the plain-prose summary followed by <|COMPLETE|> on a new line. Use no introduction or markdown headers.

#### Input Descriptions
${input}

#### Output Format
In B10:C8 Water God Reida Rei lost to Rudeus Greyrat.
<|COMPLETE|>`;
}

export function parseConsolidation(text: string, input: string) {
  const body = completedBody(text);
  const tags = new Set(input.match(/^B\d+:C\d+(?=: )/gm));
  const anchors = body.match(/\bB\d+:C\d+\b/g) ?? [];
  if (!body || !anchors.length || anchors.some(tag => !tags.has(tag))) {
    throw new Error("The consolidation did not return a summary with valid book and chunk references.");
  }
  return body;
}

export function graphRequest(settings: GraphSettings, prompt: string, maxOutputTokens: number) {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens, thinkingConfig: { thinkingLevel: settings.thinking_level, includeThoughts: false },
      ...(settings.model === GEMMA ? GEMMA_SAMPLING : {}),
    },
  };
}
