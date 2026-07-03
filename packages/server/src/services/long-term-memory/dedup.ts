import { jaccardSimilarity, tokenize, type LtmEvidenceUnit, type LtmNote } from "@marinara-engine/shared";
import type { LtmExtractionDiagnostic } from "./diagnostics.js";
import { noteIdForEvidenceUnit } from "./evidence-unit-validation.js";

export interface DedupOptions {
  exactTextMatch?: boolean;
  lexicalOverlap?: number;
  embeddingSimilarity?: number;
  withinExtraction?: boolean;
}

export interface DeduplicateUnitsInput {
  units: LtmEvidenceUnit[];
  existingNotes: LtmNote[];
  options?: DedupOptions;
}

export interface DeduplicateUnitsResult {
  deduplicated: LtmEvidenceUnit[];
  diagnostics: LtmExtractionDiagnostic[];
}

type ExistingSectionCandidate = {
  noteId: string;
  sectionKey: string;
  text: string;
  tokens: Set<string>;
};

export function deduplicateUnits(input: DeduplicateUnitsInput): DeduplicateUnitsResult {
  const exactTextMatch = input.options?.exactTextMatch ?? true;
  const lexicalThreshold = input.options?.lexicalOverlap ?? 0.85;
  const withinExtraction = input.options?.withinExtraction ?? true;
  const diagnostics: LtmExtractionDiagnostic[] = [];
  const deduplicated: LtmEvidenceUnit[] = [];
  const seenInBatch: ExistingSectionCandidate[] = [];
  const existingCandidates = existingSectionCandidates(input.existingNotes);

  for (const [candidateIndex, unit] of input.units.entries()) {
    const noteId = noteIdForEvidenceUnit(unit);
    const unitText = normalizeText(unit.text);
    const unitTokens = tokenize(unit.text);
    const candidates = withinExtraction ? [...seenInBatch, ...existingCandidates] : existingCandidates;
    const duplicate = candidates.find((candidate) => {
      if (candidate.tokens.size === 0 || unitTokens.size === 0) return false;
      if (exactTextMatch && normalizeText(candidate.text) === unitText) return true;
      if (!hasTokenIntersection(unitTokens, candidate.tokens)) return false;
      return jaccardSimilarity(unitTokens, candidate.tokens) >= lexicalThreshold;
    });

    if (duplicate) {
      diagnostics.push({
        severity: "warning",
        code: "deduplicated_evidence_unit",
        candidateIndex,
        mutationId: unit.id,
        noteId,
        message: `Dropped duplicate LTM evidence unit; matched ${duplicate.noteId}.${duplicate.sectionKey}.`,
      });
      continue;
    }

    deduplicated.push(unit);
    seenInBatch.push({
      noteId,
      sectionKey: unit.sectionKey,
      text: unit.text,
      tokens: unitTokens,
    });
  }

  return { deduplicated, diagnostics };
}

function existingSectionCandidates(notes: LtmNote[]): ExistingSectionCandidate[] {
  return notes.flatMap((note) =>
    Object.entries(note.sections).flatMap(([sectionKey, section]) => {
      const text = section.text.trim();
      if (!text) return [];
      return [{ noteId: note.id, sectionKey, text, tokens: tokenize(text) }];
    }),
  );
}

function normalizeText(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasTokenIntersection(left: Set<string>, right: Set<string>) {
  for (const token of left) {
    if (right.has(token)) return true;
  }
  return false;
}
