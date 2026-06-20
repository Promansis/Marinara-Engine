import type {
  LtmEvidenceUnit,
  LtmExtractionDropReason,
  LtmExtractionDroppedCandidate,
  LtmExtractionRecoveryHint,
  LtmNote,
} from "@marinara-engine/shared";
import { isLtmSourceLikeNote } from "@marinara-engine/shared";
import type { LtmExtractionDiagnostic } from "./diagnostics.js";

const DIALOGUE_BUCKETS = new Set<LtmEvidenceUnit["bucket"]>(["tone"]);
const RISK_BUCKETS = new Set<LtmEvidenceUnit["bucket"]>(["relationship_conflict"]);
const PLACEHOLDER_UUID = "550e8400-e29b-41d4-a716-446655440000";
const PLACEHOLDER_MERGE_HINT = "optional note for deterministic compiler";
const SOURCE_EXTRACTION_DISALLOWED_BUCKETS = new Set<LtmEvidenceUnit["bucket"]>(["character_state"]);
const CHARACTER_FACT_EVENT_SECTION_KEYS = new Set(["facts", "core", "profile"]);
const CHARACTER_FACT_DURABLE_SECTION_KEYS = new Set(["developments", "abilities", "items", "voice"]);
const EVENT_SHAPED_CHARACTER_FACT_PATTERN =
  /\b(?:arrived|departed|entered|left|went|came|returned|walked|ran|fled|attacked|fought|killed|died|met|spoke|told|asked|answered|promised|decided|agreed|refused|accepted|rejected|gave|took|found|discovered|revealed|learned|opened|closed|escaped|rescued|betrayed|confronted|warned|saved|stopped)\b/i;
const THREAD_RESOLUTION_PATTERN =
  /\b(?:resolve|resolved|resolver|resolution|would resolve|will resolve|until|when|if|requires|needs|awaits|pending|unresolved|open question|pay off|payoff|future|follow-?up|goal|must|should|cool(?:s|ed|ing)?|confess(?:ion|es|ed|ing)?|confront(?:s|ed|ing)?|dy(?:e|ing) down|explain(?:s|ed|ing|ation)?|updates?)\b/i;
const SCENE_ONLY_TONE_PATTERN = /\b(?:this scene|single scene|momentarily|for the scene|scene tone|currently|right now)\b/i;

function tokenize(value: string) {
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9]{4,}/g)
      ?.slice(0, 500) ?? [],
  );
}

function lexicalOverlap(sourceText: string, proposedText: string) {
  const sourceTokens = tokenize(sourceText);
  const proposedTokens = tokenize(proposedText);
  if (sourceTokens.size === 0 || proposedTokens.size === 0) return 0;
  let shared = 0;
  for (const token of proposedTokens) {
    if (sourceTokens.has(token)) shared++;
  }
  return shared / proposedTokens.size;
}

function quotedStrings(text: string) {
  return Array.from(text.matchAll(/"([^"]{1,240})"/g), (match) => match[1]!.trim()).filter(Boolean);
}

function hasRelationshipSupport(unit: LtmEvidenceUnit, units: LtmEvidenceUnit[], existingNotes: LtmNote[]) {
  if (unit.bucket !== "relationship_state") return true;
  if (units.some((candidate) => candidate.bucket === "relationship_event" && candidate.subjectId === unit.subjectId)) {
    return true;
  }
  return existingNotes.some(
    (note) =>
      note.id === noteIdForEvidenceUnit(unit) &&
      (note.sections.history?.text.trim() || note.sections.state?.text.trim()),
  );
}

function isSourceNote(note: LtmNote) {
  return isLtmSourceLikeNote(note);
}

export function riskForEvidenceUnit(unit: LtmEvidenceUnit): "low" | "medium" | "high" {
  if (RISK_BUCKETS.has(unit.bucket)) return "medium";
  if (unit.bucket === "relationship_state" || unit.bucket === "character_state") {
    return "medium";
  }
  return "low";
}

export type LtmEvidenceUnitValidationResult = {
  keptUnits: LtmEvidenceUnit[];
  diagnostics: LtmExtractionDiagnostic[];
  droppedCandidates: LtmExtractionDroppedCandidate[];
};

type DroppedCandidateInput = {
  candidateIndex: number;
  reason: LtmExtractionDropReason;
  message: string;
  unit?: LtmEvidenceUnit;
  snippet?: string;
};

export function validateLtmEvidenceUnits({
  units,
  sourceText,
  sourceNote,
  existingNotes,
  expectedSourceHash,
}: {
  units: LtmEvidenceUnit[];
  sourceText: string;
  sourceNote?: LtmNote;
  existingNotes: LtmNote[];
  expectedSourceHash?: string;
}): LtmEvidenceUnitValidationResult {
  const diagnostics: LtmExtractionDiagnostic[] = [];
  const droppedCandidates: LtmExtractionDroppedCandidate[] = [];
  const keptUnits: LtmEvidenceUnit[] = [];
  const keptCandidateIndexes = new Map<LtmEvidenceUnit, number>();
  const sourceEvidence = sourceNote ? `source_note:${sourceNote.id}` : null;

  if (sourceNote && !isSourceNote(sourceNote)) {
    diagnostics.push({
      severity: "error",
      code: "invalid_source_note",
      noteId: sourceNote.id,
      message: "Evidence unit extraction requires a source note.",
    });
  }

  for (const [candidateIndex, unit] of units.entries()) {
    const noteId = noteIdForEvidenceUnit(unit);
    const unitDiagnostics: LtmExtractionDiagnostic[] = [];
    const drop = (input: DroppedCandidateInput) => {
      const dropped = droppedCandidate({
        ...input,
        unit,
      });
      droppedCandidates.push(dropped);
      diagnostics.push({
        severity: "error",
        code: dropReasonDiagnosticCode(dropped.reason),
        candidateIndex,
        mutationId: unit.id,
        noteId,
        message: dropped.message,
      });
    };

    unitDiagnostics.push(...placeholderDiagnostics(unit, noteId, candidateIndex));

    if (unit.evidence.length === 0) {
      unitDiagnostics.push({
        severity: "error",
        code: "missing_evidence",
        candidateIndex,
        mutationId: unit.id,
        noteId,
        message: "Evidence unit has no evidence reference.",
      });
    }

    if (sourceEvidence && !unit.evidence.includes(sourceEvidence)) {
      unitDiagnostics.push({
        severity: "error",
        code: "missing_source_note_evidence",
        candidateIndex,
        mutationId: unit.id,
        noteId,
        message: "Evidence unit must reference the source note evidence.",
      });
    }

    if (expectedSourceHash && unit.sourceHash !== expectedSourceHash) {
      unitDiagnostics.push({
        severity: "error",
        code: "source_hash_mismatch",
        candidateIndex,
        mutationId: unit.id,
        noteId,
        message: "Evidence unit sourceHash does not match the source note hash.",
      });
    }

    if (unit.text.length > 2_000) {
      unitDiagnostics.push({
        severity: "error",
        code: "overlong_evidence_unit",
        candidateIndex,
        mutationId: unit.id,
        noteId,
        message: "Evidence unit text exceeds the maximum memory stream length.",
      });
    }

    if (isSourceSummaryPayload(unit.text)) {
      unitDiagnostics.push({
        severity: "error",
        code: "source_summary_payload",
        candidateIndex,
        mutationId: unit.id,
        noteId,
        message: "Evidence unit copies source-summary/transcript structure instead of a memory stream.",
      });
    }

    if (sourceNote && isSourceNote(sourceNote) && SOURCE_EXTRACTION_DISALLOWED_BUCKETS.has(unit.bucket)) {
      unitDiagnostics.push({
        severity: "error",
        code: "unsupported_source_extraction_bucket",
        candidateIndex,
        mutationId: unit.id,
        noteId,
        message: "Source-summary extraction does not support this memory stream.",
      });
    }

    if (isEventShapedCharacterFact(unit)) {
      unitDiagnostics.push({
        severity: "error",
        code: "event_shaped_character_fact",
        candidateIndex,
        mutationId: unit.id,
        noteId,
        message: "Character fact candidates must not capture ordinary scene actions or timeline beats.",
      });
    }

    if (isVagueThread(unit)) {
      unitDiagnostics.push({
        severity: "error",
        code: "vague_thread",
        candidateIndex,
        mutationId: unit.id,
        noteId,
        message: "Thread candidates must describe an unresolved condition and what would resolve it.",
      });
    }

    if (isSceneOnlyToneOrAnchor(unit)) {
      unitDiagnostics.push({
        severity: "error",
        code: "scene_only_tone_or_anchor",
        candidateIndex,
        mutationId: unit.id,
        noteId,
        message: "Tone and anchor candidates must describe durable atmosphere, motifs, or callbacks.",
      });
    }

    for (const quote of DIALOGUE_BUCKETS.has(unit.bucket) ? quotedStrings(unit.text) : []) {
      if (!sourceText.includes(quote)) {
        unitDiagnostics.push({
          severity: "error",
          code: "unsupported_dialogue_quote",
          candidateIndex,
          mutationId: unit.id,
          noteId,
          message: "Voice/tone quote is not present in the source text.",
        });
      }
    }

    if (lexicalOverlap(sourceText, unit.text) < 0.08) {
      diagnostics.push({
        severity: "warning",
        code: "low_lexical_evidence",
        candidateIndex,
        mutationId: unit.id,
        noteId,
        message: "Evidence unit has low lexical overlap with the source note.",
      });
    }

    const dropDiagnostic = unitDiagnostics.find((diagnostic) => diagnostic.severity === "error");
    if (dropDiagnostic) {
      const reason = diagnosticToDropReason(dropDiagnostic.code);
      if (reason) {
        drop({
          candidateIndex,
          reason,
          message: userFacingDropMessage(reason),
        });
      } else {
        diagnostics.push(...unitDiagnostics);
      }
      continue;
    }

    diagnostics.push(...unitDiagnostics);
    keptUnits.push(unit);
    keptCandidateIndexes.set(unit, candidateIndex);
  }

  const finalKeptUnits: LtmEvidenceUnit[] = [];
  for (const unit of keptUnits) {
    if (hasRelationshipSupport(unit, keptUnits, existingNotes)) {
      finalKeptUnits.push(unit);
      continue;
    }
    const candidateIndex = keptCandidateIndexes.get(unit) ?? 0;
    const noteId = noteIdForEvidenceUnit(unit);
    const dropped = droppedCandidate({
      candidateIndex,
      reason: "unsupported_bucket",
      message: userFacingDropMessage("unsupported_bucket"),
      unit,
    });
    droppedCandidates.push(dropped);
    diagnostics.push({
      severity: "error",
      code: dropReasonDiagnosticCode(dropped.reason),
      candidateIndex,
      mutationId: unit.id,
      noteId,
      message: dropped.message,
    });
  }

  return { keptUnits: finalKeptUnits, diagnostics, droppedCandidates };
}

function placeholderDiagnostics(unit: LtmEvidenceUnit, noteId: string, candidateIndex: number): LtmExtractionDiagnostic[] {
  const diagnostics: LtmExtractionDiagnostic[] = [];
  const hasPlaceholderIdentifier = (value: string) => value.toLowerCase().includes("lowercase_snake_case");

  if (unit.id.toLowerCase() === PLACEHOLDER_UUID) {
    diagnostics.push({
      severity: "error",
      code: "placeholder_evidence_unit_id",
      candidateIndex,
      mutationId: unit.id,
      noteId,
      message: "Evidence unit uses a copied placeholder UUID.",
    });
  }

  if (hasPlaceholderIdentifier(unit.subjectId)) {
    diagnostics.push({
      severity: "error",
      code: "placeholder_subject_id",
      candidateIndex,
      mutationId: unit.id,
      noteId,
      message: "Evidence unit subjectId uses a copied placeholder identifier.",
    });
  }

  if (hasPlaceholderIdentifier(unit.sectionKey)) {
    diagnostics.push({
      severity: "error",
      code: "placeholder_section_key",
      candidateIndex,
      mutationId: unit.id,
      noteId,
      message: "Evidence unit sectionKey uses a copied placeholder identifier.",
    });
  }

  if (unit.mergeHint?.trim().toLowerCase() === PLACEHOLDER_MERGE_HINT) {
    diagnostics.push({
      severity: "error",
      code: "placeholder_merge_hint",
      candidateIndex,
      mutationId: unit.id,
      noteId,
      message: "Evidence unit mergeHint uses copied schema/example text.",
    });
  }

  for (const link of unit.links) {
    if (link.target === "target_note_id") {
      diagnostics.push({
        severity: "error",
        code: "placeholder_link_target",
        candidateIndex,
        mutationId: unit.id,
        noteId,
        message: "Evidence unit link target uses a copied placeholder note id.",
      });
    }
  }

  return diagnostics;
}

function isEventShapedCharacterFact(unit: LtmEvidenceUnit) {
  if (unit.bucket !== "character_fact") return false;
  if (CHARACTER_FACT_DURABLE_SECTION_KEYS.has(unit.sectionKey)) return false;
  if (!CHARACTER_FACT_EVENT_SECTION_KEYS.has(unit.sectionKey)) return false;
  return EVENT_SHAPED_CHARACTER_FACT_PATTERN.test(unit.text);
}

function isVagueThread(unit: LtmEvidenceUnit) {
  if (unit.bucket !== "thread") return false;
  return !THREAD_RESOLUTION_PATTERN.test(unit.text);
}

function isSceneOnlyToneOrAnchor(unit: LtmEvidenceUnit) {
  if (unit.bucket !== "tone" && unit.bucket !== "anchor") return false;
  return SCENE_ONLY_TONE_PATTERN.test(unit.text);
}

export function noteIdForEvidenceUnit(unit: Pick<LtmEvidenceUnit, "bucket" | "subjectId" | "sectionKey">) {
  if (unit.bucket === "timeline_event") return prefixed("timeline", unit.subjectId);
  if (unit.bucket === "thread") return prefixed("thread", unit.subjectId);
  if (unit.bucket === "world_fact") return prefixed("world", unit.subjectId);
  if (unit.bucket === "tone") return prefixed("tone", unit.subjectId);
  if (unit.bucket.startsWith("relationship_")) return prefixed("rel", unit.subjectId);
  if (unit.bucket === "anchor") return noteIdForAnchor(unit.subjectId, unit.sectionKey);
  return prefixed("char", unit.subjectId);
}

function prefixed(prefix: string, subjectId: string) {
  return subjectId.startsWith(`${prefix}_`) ? subjectId : `${prefix}_${subjectId}`;
}

function noteIdForAnchor(subjectId: string, sectionKey: string) {
  if (sectionKey.startsWith("tone")) return prefixed("tone", subjectId);
  return prefixed("world", subjectId);
}

function isSourceSummaryPayload(text: string) {
  return /\b(?:source note|chat summary|transcript|events?:|timeline:|scene summary:)\b/i.test(text);
}

function droppedCandidate(input: Required<Pick<DroppedCandidateInput, "candidateIndex" | "reason" | "message" | "unit">> & {
  snippet?: string;
}): LtmExtractionDroppedCandidate {
  return {
    index: input.candidateIndex,
    reason: input.reason,
    message: input.message,
    ...(safeSnippet(input.snippet ?? input.unit.text) ? { snippet: safeSnippet(input.snippet ?? input.unit.text)! } : {}),
    ...(recoveryHintForUnit(input.unit) ? { recovery: recoveryHintForUnit(input.unit)! } : {}),
  };
}

function safeSnippet(text: string | undefined) {
  const value = text?.replace(/\s+/g, " ").trim() ?? "";
  if (!value || value.length < 12) return undefined;
  return value.length > 280 ? `${value.slice(0, 277).trim()}...` : value;
}

function recoveryHintForUnit(unit: LtmEvidenceUnit): LtmExtractionRecoveryHint {
  return {
    noteType: targetNoteTypeForUnit(unit),
    noteId: noteIdForEvidenceUnit(unit),
    sectionKey: noteIdSectionKeyForUnit(unit),
    status: targetStatusForUnit(unit),
  };
}

function targetNoteTypeForUnit(unit: LtmEvidenceUnit): LtmNote["type"] {
  if (unit.bucket.startsWith("relationship_")) return "relationship";
  if (unit.bucket === "timeline_event") return "timeline_event";
  if (unit.bucket === "thread") return "thread";
  if (unit.bucket === "world_fact") return "world";
  if (unit.bucket === "tone") return "tone";
  if (unit.bucket === "anchor") return noteIdForEvidenceUnit(unit).startsWith("tone_") ? "tone" : "world";
  return "character";
}

function noteIdSectionKeyForUnit(unit: LtmEvidenceUnit) {
  if (unit.bucket === "timeline_event") return unit.sectionKey || "event";
  if (unit.bucket === "relationship_event") return "history";
  if (unit.bucket === "relationship_state") return "state";
  if (unit.bucket === "character_state") return "current_state";
  if (unit.bucket === "character_fact") return unit.sectionKey || "facts";
  if (unit.bucket === "tone") return "observations";
  if (unit.bucket === "thread" && unit.status === "resolved") return "summary";
  return unit.sectionKey;
}

function targetStatusForUnit(unit: LtmEvidenceUnit): LtmNote["status"] {
  if (unit.status === "archived") return "archived";
  if (unit.bucket === "thread" && unit.status === "resolved") return "archived";
  if (unit.status === "resolved") return "resolved";
  return "active";
}

function diagnosticToDropReason(code: string): LtmExtractionDropReason | null {
  if (
    code === "placeholder_evidence_unit_id" ||
    code === "placeholder_subject_id" ||
    code === "placeholder_section_key" ||
    code === "placeholder_merge_hint" ||
    code === "placeholder_link_target"
  ) {
    return "placeholder_output";
  }
  if (code === "unsupported_dialogue_quote") return "quote_not_found_in_source";
  if (code === "missing_source_note_evidence" || code === "missing_evidence") return "missing_source_evidence";
  if (code === "source_summary_payload") return "source_summary_payload";
  if (
    code === "unsupported_source_extraction_bucket" ||
    code === "relationship_state_without_history" ||
    code === "event_shaped_character_fact" ||
    code === "vague_thread" ||
    code === "scene_only_tone_or_anchor"
  ) {
    return "unsupported_bucket";
  }
  if (code === "overlong_evidence_unit") return "too_long_to_keep_safely";
  return null;
}

function dropReasonDiagnosticCode(reason: LtmExtractionDropReason) {
  switch (reason) {
    case "placeholder_output":
      return "candidate_dropped_placeholder_output";
    case "quote_not_found_in_source":
      return "candidate_dropped_quote_not_found_in_source";
    case "missing_source_evidence":
      return "candidate_dropped_missing_source_evidence";
    case "source_summary_payload":
      return "candidate_dropped_source_summary_payload";
    case "unsupported_bucket":
      return "candidate_dropped_unsupported_bucket";
    case "target_note_outside_scope":
      return "candidate_dropped_target_note_outside_scope";
    case "too_long_to_keep_safely":
      return "candidate_dropped_too_long_to_keep_safely";
    case "invalid_format":
      return "candidate_dropped_invalid_format";
  }
}

function userFacingDropMessage(reason: LtmExtractionDropReason) {
  switch (reason) {
    case "placeholder_output":
      return "Dropped copied placeholder output.";
    case "quote_not_found_in_source":
      return "Dropped a quote that was not present in the source.";
    case "missing_source_evidence":
      return "Dropped a candidate that did not include usable source evidence.";
    case "source_summary_payload":
      return "Dropped a candidate that looked like a source-summary transcript instead of a memory stream.";
    case "unsupported_bucket":
      return "Dropped a candidate that used the wrong memory stream for source-summary extraction.";
    case "target_note_outside_scope":
      return "Dropped a candidate that targeted a memory outside this source's scope.";
    case "too_long_to_keep_safely":
      return "Dropped a candidate that was too long to keep safely.";
    case "invalid_format":
      return "Dropped a malformed candidate.";
  }
}
