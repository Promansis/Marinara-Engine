import type { LtmEvidenceUnit, LtmNote } from "@marinara-engine/shared";
import { type LtmExtractionDiagnostic } from "./validation.js";

const DIALOGUE_BUCKETS = new Set<LtmEvidenceUnit["bucket"]>(["tone"]);
const RISK_BUCKETS = new Set<LtmEvidenceUnit["bucket"]>(["relationship_conflict"]);
const PLACEHOLDER_UUID = "550e8400-e29b-41d4-a716-446655440000";
const PLACEHOLDER_MERGE_HINT = "optional note for deterministic compiler";

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
  return (
    note.type === "source" ||
    (note.type === "scene" && (note.tags.includes("source_summary") || note.tags.includes("chat_summary")))
  );
}

export function riskForEvidenceUnit(unit: LtmEvidenceUnit): "low" | "medium" | "high" {
  if (RISK_BUCKETS.has(unit.bucket)) return "medium";
  if (unit.bucket === "relationship_state" || unit.bucket === "character_state") {
    return "medium";
  }
  return "low";
}

export function validateLtmEvidenceUnits({
  units,
  sourceText,
  sourceNote,
  existingNotes,
  expectedSourceHash,
  rejectPlaceholderOutput = true,
}: {
  units: LtmEvidenceUnit[];
  sourceText: string;
  sourceNote?: LtmNote;
  existingNotes: LtmNote[];
  expectedSourceHash?: string;
  rejectPlaceholderOutput?: boolean;
}) {
  const diagnostics: LtmExtractionDiagnostic[] = [];
  const sourceEvidence = sourceNote ? `source_note:${sourceNote.id}` : null;

  if (sourceNote && !isSourceNote(sourceNote)) {
    diagnostics.push({
      severity: "error",
      code: "invalid_source_note",
      noteId: sourceNote.id,
      message: "Evidence unit extraction requires a source note.",
    });
  }

  for (const unit of units) {
    const noteId = noteIdForEvidenceUnit(unit);
    if (rejectPlaceholderOutput) {
      for (const diagnostic of placeholderDiagnostics(unit, noteId)) {
        diagnostics.push(diagnostic);
      }
    }

    if (unit.evidence.length === 0) {
      diagnostics.push({
        severity: "error",
        code: "missing_evidence",
        mutationId: unit.id,
        noteId,
        message: "Evidence unit has no evidence reference.",
      });
    }

    if (sourceEvidence && !unit.evidence.includes(sourceEvidence)) {
      diagnostics.push({
        severity: "error",
        code: "missing_source_note_evidence",
        mutationId: unit.id,
        noteId,
        message: "Evidence unit must reference the source note evidence.",
      });
    }

    if (expectedSourceHash && unit.sourceHash !== expectedSourceHash) {
      diagnostics.push({
        severity: "error",
        code: "source_hash_mismatch",
        mutationId: unit.id,
        noteId,
        message: "Evidence unit sourceHash does not match the source note hash.",
      });
    }

    if (unit.text.length > 2_000) {
      diagnostics.push({
        severity: "error",
        code: "overlong_evidence_unit",
        mutationId: unit.id,
        noteId,
        message: "Evidence unit text exceeds the maximum typed-memory length.",
      });
    }

    if (isSourceSummaryPayload(unit.text)) {
      diagnostics.push({
        severity: "error",
        code: "source_summary_payload",
        mutationId: unit.id,
        noteId,
        message: "Evidence unit copies source-summary/transcript structure instead of typed memory.",
      });
    }

    if (!hasRelationshipSupport(unit, units, existingNotes)) {
      diagnostics.push({
        severity: "warning",
        code: "relationship_state_without_history",
        mutationId: unit.id,
        noteId,
        message: "Relationship state should be backed by relationship event evidence or existing state.",
      });
    }

    for (const quote of DIALOGUE_BUCKETS.has(unit.bucket) ? quotedStrings(unit.text) : []) {
      if (!sourceText.includes(quote)) {
        diagnostics.push({
          severity: "error",
          code: "unsupported_dialogue_quote",
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
        mutationId: unit.id,
        noteId,
        message: "Evidence unit has low lexical overlap with the source note.",
      });
    }
  }

  return diagnostics;
}

function placeholderDiagnostics(unit: LtmEvidenceUnit, noteId: string): LtmExtractionDiagnostic[] {
  const diagnostics: LtmExtractionDiagnostic[] = [];
  const hasPlaceholderIdentifier = (value: string) => value.toLowerCase().includes("lowercase_snake_case");

  if (unit.id.toLowerCase() === PLACEHOLDER_UUID) {
    diagnostics.push({
      severity: "error",
      code: "placeholder_evidence_unit_id",
      mutationId: unit.id,
      noteId,
      message: "Evidence unit uses a copied placeholder UUID.",
    });
  }

  if (hasPlaceholderIdentifier(unit.subjectId)) {
    diagnostics.push({
      severity: "error",
      code: "placeholder_subject_id",
      mutationId: unit.id,
      noteId,
      message: "Evidence unit subjectId uses a copied placeholder identifier.",
    });
  }

  if (hasPlaceholderIdentifier(unit.sectionKey)) {
    diagnostics.push({
      severity: "error",
      code: "placeholder_section_key",
      mutationId: unit.id,
      noteId,
      message: "Evidence unit sectionKey uses a copied placeholder identifier.",
    });
  }

  if (unit.mergeHint?.trim().toLowerCase() === PLACEHOLDER_MERGE_HINT) {
    diagnostics.push({
      severity: "error",
      code: "placeholder_merge_hint",
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
        mutationId: unit.id,
        noteId,
        message: "Evidence unit link target uses a copied placeholder note id.",
      });
    }
  }

  return diagnostics;
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
