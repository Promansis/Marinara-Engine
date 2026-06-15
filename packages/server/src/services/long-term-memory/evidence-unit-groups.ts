import type {
  LtmEvidenceUnit,
  LtmEvidenceUnitBucket,
  LtmEvidenceUnitExtractionResponse,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { recordLtmDebugEvent } from "./debug-log.js";
import {
  runLongTermMemoryEvidenceUnitExtraction,
  type RunLongTermMemoryEvidenceUnitExtractionOptions,
} from "./evidence-unit-extraction.js";

const SHARED_RULES = [
  "Return strict JSON only. Do not explain.",
  "Source notes are audit evidence, not active recall memory.",
  "Do not output source summaries, transcript summaries, or final write operations.",
  "Extract every distinct durable memory unit supported by the source.",
  "Emit zero or more units per bucket. Do not stop after the first valid unit.",
  "Prefer several compact units over one blended paragraph.",
  "Each unit must be compact, typed, and useful for future continuity.",
  "Every unit must include at least one supplied evidence string, including source_note:<id>.",
  "Use real lowercase snake_case subjectId and sectionKey values derived from the source.",
  "Never output placeholder values such as lowercase_snake_case_scope_id, lowercase_snake_case, target_note_id, or copied schema/example text.",
  "Do not copy schema/example placeholder values.",
  "Omit optional fields unless they are real and evidence-backed.",
  "Use sourceHash exactly as supplied.",
  "Set confidence and salience from 0 to 1.",
  "Do not emit current scene, relationship arc, boundary, or preference memories from source-summary extraction.",
  "For enum fields, choose exactly one string from the allowed arrays. Do not join multiple values with |.",
].join("\n");

const GROUPED_PROMPTS: Record<LtmEvidenceUnitBucketGroup, string> = {
  character: [
    "You extract character evidence units from a source note.",
    SHARED_RULES,
    "Extract character_fact and character_state units.",
    "Use character_fact for stable facts (traits, history, background, fixed attributes).",
    "Use character_state for current conditions (mood, aim, capability, physical position, health).",
  ].join("\n"),
  relationship: [
    "You extract relationship evidence units from a source note.",
    SHARED_RULES,
    "Extract relationship_event, relationship_state, and relationship_conflict units.",
    "Use relationship_event for evidence-backed history items between characters.",
    "Use relationship_state for current reduced relationship state.",
    "Use relationship_conflict for unresolved contradictions or instability between characters.",
  ].join("\n"),
  world_timeline: [
    "You extract world and timeline evidence units from a source note.",
    SHARED_RULES,
    "Extract world_fact and timeline_event units.",
    "Use world_fact for stable world or lore facts (locations, rules, factions, history).",
    "Use timeline_event for historical source-summary scenes or beats; never call those current_scene.",
    "Typed memories may link to timeline_event notes using occurred_in, triggered_by, resolved_in, or evidenced_by.",
    "Keep source-note provenance as source_note evidence; timeline links describe story structure, not source provenance.",
  ].join("\n"),
  thread: [
    "You extract thread evidence units from a source note.",
    SHARED_RULES,
    "Extract thread units only: unresolved situations, questions, tensions, or goals.",
    "Do not extract any other bucket type.",
    "Mark threads as active when the situation is unresolved, or resolved/archived when it is closed.",
  ].join("\n"),
  tone_anchor: [
    "You extract tone and anchor evidence units from a source note.",
    SHARED_RULES,
    "Extract tone and anchor units.",
    "Use tone for durable atmosphere, scene tone, or voice observations.",
    "Use anchor for recurring motifs, symbols, or anchoring elements that span categories.",
    "For tone quotes, quote only exact text present in the source.",
  ].join("\n"),
};

export type LtmEvidenceUnitBucketGroup =
  | "character"
  | "relationship"
  | "world_timeline"
  | "thread"
  | "tone_anchor";

export interface LtmBucketGroupConfig {
  group: LtmEvidenceUnitBucketGroup;
  label: string;
  buckets: LtmEvidenceUnitBucket[];
  systemPrompt: string;
}

export const LTM_BUCKET_GROUPS: LtmBucketGroupConfig[] = [
  {
    group: "character",
    label: "characters",
    buckets: ["character_fact", "character_state"],
    systemPrompt: GROUPED_PROMPTS.character,
  },
  {
    group: "relationship",
    label: "relationships",
    buckets: ["relationship_event", "relationship_state", "relationship_conflict"],
    systemPrompt: GROUPED_PROMPTS.relationship,
  },
  {
    group: "world_timeline",
    label: "world & timeline",
    buckets: ["world_fact", "timeline_event"],
    systemPrompt: GROUPED_PROMPTS.world_timeline,
  },
  {
    group: "thread",
    label: "threads",
    buckets: ["thread"],
    systemPrompt: GROUPED_PROMPTS.thread,
  },
  {
    group: "tone_anchor",
    label: "tone & anchors",
    buckets: ["tone", "anchor"],
    systemPrompt: GROUPED_PROMPTS["tone_anchor"],
  },
];

export interface GroupedEvidenceUnitResult extends LtmEvidenceUnitExtractionResponse {
  group: LtmEvidenceUnitBucketGroup;
}

export function runGroupedEvidenceUnitExtraction(
  options: RunLongTermMemoryEvidenceUnitExtractionOptions & {
    groupedExtractionGroups?: LtmBucketGroupConfig[];
  },
): Promise<GroupedEvidenceUnitResult[]> {
  const groups = options.groupedExtractionGroups ?? LTM_BUCKET_GROUPS;
  const started = Date.now();

  return Promise.all(
    groups.map(async (group) => {
      const groupStarted = Date.now();
      await recordLtmDebugEvent({
        operationId: options.operationId,
        phase: "llm",
        action: "evidence_unit_group_request",
        status: "started",
        sourceNoteId: options.sourceNote.id,
        provider: options.provider.constructor.name,
        model: options.model,
        counts: {
          groupBuckets: group.buckets.length,
        },
        details: {
          group: group.group,
          buckets: group.buckets,
        },
      });

      try {
        const result = await runLongTermMemoryEvidenceUnitExtraction({
          ...options,
          systemPrompt: group.systemPrompt,
          allowedBuckets: group.buckets,
        });

        await recordLtmDebugEvent({
          operationId: options.operationId,
          phase: "llm",
          action: "evidence_unit_group_response",
          status: "ok",
          sourceNoteId: options.sourceNote.id,
          provider: options.provider.constructor.name,
          model: options.model,
          durationMs: Date.now() - groupStarted,
          counts: {
            units: result.units.length,
            groupBuckets: group.buckets.length,
          },
          details: {
            group: group.group,
            summary: result.summary.slice(0, 500),
          },
        });

        return { ...result, group: group.group };
      } catch (err) {
        await recordLtmDebugEvent({
          operationId: options.operationId,
          phase: "llm",
          action: "evidence_unit_group_response",
          status: "error",
          sourceNoteId: options.sourceNote.id,
          provider: options.provider.constructor.name,
          model: options.model,
          durationMs: Date.now() - groupStarted,
          error: err,
          details: {
            group: group.group,
          },
        });
        logger.warn(
          "[ltm] Group %s extraction failed, returning empty units: %s",
          group.group,
          err instanceof Error ? err.message : String(err),
        );
        return { summary: "", units: [] as LtmEvidenceUnit[], group: group.group };
      }
    }),
  ).then((results) => {
    const totalUnits = results.reduce((sum, result) => sum + result.units.length, 0);
    logger.info(
      "[ltm] Grouped extraction completed in %d ms: %d units across %d groups",
      Date.now() - started,
      totalUnits,
      results.length,
    );
    return results;
  });
}

export function mergeGroupedEvidenceUnitResults(
  results: GroupedEvidenceUnitResult[],
): LtmEvidenceUnitExtractionResponse {
  const allUnits: LtmEvidenceUnit[] = [];
  const summaries: string[] = [];
  for (const result of results) {
    allUnits.push(...result.units);
    if (result.summary) summaries.push(result.summary);
  }
  return {
    summary: summaries.join("; "),
    units: allUnits,
  };
}
