import type { LtmDraftMutation, LtmExtractionResponse, LtmNote } from "@marinara-engine/shared";

export type LtmExtractionDiagnostic = {
  severity: "warning" | "error";
  code: string;
  mutationId?: string;
  noteId?: string;
  message: string;
};

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

function textForMutation(mutation: LtmDraftMutation) {
  if (mutation.kind === "create_note") {
    return Object.values(mutation.note.sections)
      .map((section) => section.text)
      .join("\n");
  }
  if (mutation.kind === "append_section") return mutation.text;
  if (mutation.kind === "update_section") return mutation.section.text;
  return mutation.summary;
}

function noteIdForMutation(mutation: LtmDraftMutation) {
  return mutation.kind === "create_note" ? mutation.note.id : mutation.noteId;
}

function sectionKeyForMutation(mutation: LtmDraftMutation) {
  if (mutation.kind === "append_section" || mutation.kind === "update_section") return mutation.sectionKey;
  return null;
}

function targetsSceneOrSourceNote(mutation: LtmDraftMutation, existing: LtmNote | undefined) {
  if (mutation.kind === "create_note") {
    return (
      mutation.note.type === "source" ||
      mutation.note.type === "scene" ||
      mutation.note.tags.includes("source_summary") ||
      mutation.note.tags.includes("chat_summary")
    );
  }
  return (
    mutation.noteId.startsWith("source_") ||
    mutation.noteId.startsWith("scene_") ||
    existing?.type === "source" ||
    existing?.type === "scene" ||
    existing?.tags.includes("source_summary") === true ||
    existing?.tags.includes("chat_summary") === true
  );
}

export function validateLtmExtractionResponse({
  response,
  sourceText,
  existingNotes,
  sourceNote,
}: {
  response: LtmExtractionResponse;
  sourceText: string;
  existingNotes: LtmNote[];
  sourceNote?: LtmNote;
}) {
  const diagnostics: LtmExtractionDiagnostic[] = [];
  const existingById = new Map(existingNotes.map((note) => [note.id, note]));
  const sourceEvidence = sourceNote ? `source_note:${sourceNote.id}` : null;

  for (const mutation of response.mutations) {
    const noteId = noteIdForMutation(mutation);
    const text = textForMutation(mutation);
    const existing = existingById.get(noteId);

    if (mutation.evidence.length === 0) {
      diagnostics.push({
        severity: "error",
        code: "missing_evidence",
        mutationId: mutation.id,
        noteId,
        message: "Mutation has no evidence reference.",
      });
    }

    if (sourceNote && noteId === sourceNote.id) {
      diagnostics.push({
        severity: "error",
        code: "source_note_mutation",
        mutationId: mutation.id,
        noteId,
        message: "Source extraction cannot mutate the source note; create or update typed memory notes instead.",
      });
    }

    if (sourceNote && targetsSceneOrSourceNote(mutation, existing)) {
      diagnostics.push({
        severity: "error",
        code: "scene_or_source_note_from_source",
        mutationId: mutation.id,
        noteId,
        message: "Source extraction cannot create or update scene/source notes; scene content stays in the source note.",
      });
    }

    if (sourceEvidence && !mutation.evidence.includes(sourceEvidence)) {
      diagnostics.push({
        severity: "warning",
        code: "missing_source_note_evidence",
        mutationId: mutation.id,
        noteId,
        message: "Mutation does not reference the source note evidence.",
      });
    }

    if (lexicalOverlap(sourceText, text) < 0.08) {
      diagnostics.push({
        severity: "warning",
        code: "low_lexical_evidence",
        mutationId: mutation.id,
        noteId,
        message: "Proposed text has low lexical overlap with the source note.",
      });
    }

    if (mutation.kind === "create_note" && existing) {
      diagnostics.push({
        severity: "error",
        code: "duplicate_note",
        mutationId: mutation.id,
        noteId,
        message: `Mutation creates an existing note: ${noteId}.`,
      });
    }

    const sectionKey = sectionKeyForMutation(mutation);
    if (sectionKey && existing?.sections[sectionKey]?.text.trim()) {
      const existingText = existing.sections[sectionKey]!.text.trim();
      if (mutation.kind === "update_section" && existingText !== mutation.section.text.trim()) {
        diagnostics.push({
          severity: "warning",
          code: "section_conflict",
          mutationId: mutation.id,
          noteId,
          message: `Mutation overwrites existing ${noteId}.${sectionKey}.`,
        });
      }
      if (mutation.kind === "append_section" && existingText.includes(mutation.text.trim())) {
        diagnostics.push({
          severity: "warning",
          code: "duplicate_section_text",
          mutationId: mutation.id,
          noteId,
          message: `Mutation repeats existing ${noteId}.${sectionKey} text.`,
        });
      }
    }

  }

  return diagnostics;
}
