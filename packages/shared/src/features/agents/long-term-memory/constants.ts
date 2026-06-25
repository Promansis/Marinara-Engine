import type { LtmExtractionReasoningEffort, LtmExtractionVerbosity } from "./schema.js";
import type { LongTermMemoryRecallStyle } from "../../../types/chat.js";

export const DEFAULT_LTM_EXTRACTION_REASONING_EFFORT = "low" satisfies LtmExtractionReasoningEffort;
export const DEFAULT_LTM_EXTRACTION_VERBOSITY = "low" satisfies LtmExtractionVerbosity;
export const DEFAULT_LTM_EXTRACTION_MAX_TOKENS = 8192;
export const DEFAULT_LTM_EXTRACTION_TEMPERATURE = 0;
export const DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS = 8_192;
export const DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS = 4_096;
export const DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS = 12;
export const DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS = 4_096;
export const LTM_DRAFT_MUTATION_LIMIT = 25;

export const DEFAULT_LTM_EXTRACTION_PROMPT = [
  "You extract structured memory-stream evidence units from a source note.",
  "Return strict JSON only. Do not explain.",
  "Do not include thinking, analysis, markdown, or <think> tags. Output JSON object only.",
  "Source notes are audit evidence, not active recall memory.",
  "Do not output source summaries, transcript summaries, or final write operations.",
  "Extract every distinct durable memory stream supported by the source.",
  "Emit zero or more units per stream. Prefer a few substantial units that capture the complete fact over many fragmentary observations.",
  "Scan stream groups explicitly: timeline beats (timeline_event); relationships (relationship_event, relationship_state, relationship_conflict); open loops (thread); character facts (character_fact); world facts (world_fact); style and motifs (tone, anchor).",
  "Use one best stream per fact. If a detail fits both a timeline and character/relationship stream, emit the plot-changing action as timeline_event or relationship_event and reserve character_fact for durable identity, backstory, permanent development, ability, item, or exact voice evidence.",
  "Do not duplicate the same fact across streams or sections.",
  "Write source-extracted memories in past-tense/outcome phrasing unless the fact is a durable present-tense rule or trait.",
  "",
  "SOURCE CONCEPT MAPPING:",
  "- Character developments (irreversible changes) → character_fact with sectionKey \"developments\".",
  "- Character abilities → character_fact with sectionKey \"abilities\".",
  "- Character voice/quotes → character_fact with sectionKey \"voice\".",
  "- Items tied to a character → character_fact with sectionKey \"items\" and the character's subjectId.",
  "- Items not tied to a character → world_fact with sectionKey \"items\".",
  "- Callbacks → thread. Prepend [CALLBACK] in the text. Include planted element, payoff target, and status.",
  "",
  "SECTION KEY CONVENTIONS:",
  "- character_fact: facts, developments, abilities, voice, or items. Never use it for ordinary actions, scene beats, decisions, arrivals, departures, promises, discoveries, relationship moments, moods, wounds, resources, aims, or location.",
  "- relationship_event: history.",
  "- relationship_state: state, only when backed by a same-pass relationship_event or existing relationship note.",
  "- relationship_conflict: conflict.",
  "- world_fact: facts or items.",
  "- timeline_event: event.",
  "- thread: summary. The text must describe an unresolved situation and what would resolve it. When the thread is marked resolved, you MUST also emit a parallel relationship_event (sectionKey history) for each affected relationship subject, or a timeline_event (sectionKey event) if no relationship subject — capturing what changed because of the resolution in past-tense outcome phrasing. Link fan-out units back to the thread note id with relation \"resolved_in\".",
  "- tone: observations. World/session-level atmospheric register only, not one-scene mood.",
  "- anchor: the source section key. Recurring motif or planted callback only.",
  "",
  "Each unit must be assigned to one memory stream and be useful for future continuity.",
  "Every unit must include at least one supplied evidence string, including source_note:<id>.",
  "Use real lowercase snake_case subjectId and sectionKey values derived from the source.",
  "Never output placeholder values such as lowercase_snake_case_scope_id, lowercase_snake_case, target_note_id, or copied schema/example text.",
  "Do not copy schema/example placeholder values.",
  "Omit optional fields unless they are real and evidence-backed.",
  "Use timeline_event for historical source-summary scenes or beats; never call those current_scene.",
  "Memory streams may link to timeline_event notes using occurred_in, triggered_by, resolved_in, or evidenced_by.",
  "Keep source-note provenance as source_note evidence; timeline links describe story structure, not source provenance.",
  "Use sourceHash exactly as supplied.",
  "Set confidence and salience from 0 to 1.",
  "For voice/tone quotes, quote only exact text present in the source.",
  "Do not emit current scene, current state, character_state, relationship arc, boundary, or preference memories from source-summary extraction.",
  "\"resolved\" status is reserved for thread memories only. Never set status \"resolved\" on relationship, character, world, timeline, tone, or anchor streams.",
  "For enum fields, choose exactly one string from the allowed arrays. Do not join multiple values with |.",
].join("\n");

export const DEFAULT_LTM_RECALL_STYLE = "balanced" satisfies LongTermMemoryRecallStyle;
export const DEFAULT_LTM_RECALL_PREAMBLE = "Relevant long-term memories for this reply:";

export const LTM_RECALL_STYLE_WEIGHTS = {
  balanced: {
    semanticWeight: 0.6,
    lexicalWeight: 0.3,
    graphWeight: 0.1,
    metadataWeight: 1,
  },
  exact: {
    semanticWeight: 0.15,
    lexicalWeight: 1,
    graphWeight: 0,
    metadataWeight: 0.3,
  },
  broad: {
    semanticWeight: 0.55,
    lexicalWeight: 0.2,
    graphWeight: 0.8,
    metadataWeight: 0.8,
  },
  story: {
    semanticWeight: 0.45,
    lexicalWeight: 0.25,
    graphWeight: 0.35,
    metadataWeight: 0.8,
  },
} as const satisfies Record<
  LongTermMemoryRecallStyle,
  {
    semanticWeight: number;
    lexicalWeight: number;
    graphWeight: number;
    metadataWeight: number;
  }
>;

export const DEFAULT_LTM_RECALL_STYLE_WEIGHTS = LTM_RECALL_STYLE_WEIGHTS[DEFAULT_LTM_RECALL_STYLE];

export type LtmRecallWeights = {
  semanticWeight: number;
  lexicalWeight: number;
  graphWeight: number;
  metadataWeight: number;
};

export function clampLtmRecallWeight(value: unknown, fallback: number, min = 0, max = 2) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function readLtmRecallWeightOverrides(
  metadata: Record<string, unknown>,
  fallback: LtmRecallWeights,
): LtmRecallWeights {
  const read = (value: unknown, defaultValue: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : defaultValue;
  return {
    semanticWeight: read(metadata.longTermMemorySemanticWeight, fallback.semanticWeight, 0, 1),
    lexicalWeight: read(metadata.longTermMemoryLexicalWeight, fallback.lexicalWeight, 0, 1),
    graphWeight: read(metadata.longTermMemoryGraphWeight, fallback.graphWeight, 0, 1),
    metadataWeight: read(metadata.longTermMemoryMetadataWeight, fallback.metadataWeight, 0, 2),
  };
}

export function parseLongTermMemoryRecallStyle(value: unknown): LongTermMemoryRecallStyle {
  return value === "exact" || value === "broad" || value === "story" ? value : DEFAULT_LTM_RECALL_STYLE;
}
