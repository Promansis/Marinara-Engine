import { randomUUID } from "node:crypto";
import type {
  LtmDraftMutation,
  LtmDraftRisk,
  LtmEvidenceUnit,
  LtmExtractionResponse,
  LtmMode,
  LtmNote,
  LtmNoteType,
  LtmScope,
  LtmSection,
  LtmStatus,
} from "@marinara-engine/shared";
import { noteIdForEvidenceUnit, riskForEvidenceUnit } from "./evidence-unit-validation.js";
import { formatRelationshipReduction, reduceRelationshipEvidenceUnits } from "./relationship-reducer.js";

export interface CompileLtmEvidenceUnitsOptions {
  units: LtmEvidenceUnit[];
  existingNotes: LtmNote[];
  scope: LtmScope;
  modes: LtmMode[];
  createdAt?: string;
  summary?: string;
}

type UnitTarget = {
  noteId: string;
  noteType: LtmNoteType;
  sectionKey: string;
  status: LtmStatus;
  tags: string[];
};

export function compileLtmEvidenceUnits(options: CompileLtmEvidenceUnitsOptions): LtmExtractionResponse {
  const timestamp = options.createdAt ?? new Date().toISOString();
  const existingById = new Map(options.existingNotes.map((note) => [note.id, note]));
  const mutations: LtmDraftMutation[] = [];
  const unitsByNote = new Map<string, LtmEvidenceUnit[]>();

  for (const unit of options.units) {
    const noteId = noteIdForEvidenceUnit(unit);
    const group = unitsByNote.get(noteId) ?? [];
    group.push(unit);
    unitsByNote.set(noteId, group);
  }

  for (const [noteId, units] of unitsByNote) {
    const target = targetForUnit(units[0]!);
    const existing = existingById.get(noteId);
    const sections = sectionsForUnits(units, existing, timestamp);
    const links = uniqueLinks(units.flatMap((unit) => unit.links).filter((link) => link.target !== noteId));
    const risk = maxRisk(units.map(riskForEvidenceUnit));
    const evidence = uniqueStrings(units.flatMap((unit) => unit.evidence)).slice(0, 20);
    const confidence = Math.min(...units.map((unit) => unit.confidence));

    if (target.noteType === "relationship" && units.some((unit) => unit.bucket === "relationship_conflict")) {
      const conflictUnit = units.find((unit) => unit.bucket === "relationship_conflict")!;
      mutations.push({
        id: randomUUID(),
        kind: "flag_conflict",
        risk: "high",
        confidence: conflictUnit.confidence,
        summary: `Flag relationship conflict for ${noteId}`,
        evidence: conflictUnit.evidence,
        noteId,
        conflict: {
          field: conflictUnit.sectionKey,
          existing: existing?.sections[conflictUnit.sectionKey]?.text ?? "",
          proposed: conflictUnit.text,
          resolution: "pending",
          policy: "manual_review",
        },
      });
      continue;
    }

    if (!existing) {
      mutations.push({
        id: randomUUID(),
        kind: "create_note",
        risk,
        confidence,
        summary: `Create ${target.noteType} memory ${noteId}`,
        evidence,
        note: {
          id: noteId,
          type: target.noteType,
          status: target.status,
          modes: options.modes,
          scope: options.scope,
          tags: target.tags,
          links,
          sections,
        },
      });
      continue;
    }

    for (const [sectionKey, section] of Object.entries(sections)) {
      const existingText = existing.sections[sectionKey]?.text.trim();
      if (existingText && existingText !== section.text.trim() && isHighRiskOverwrite(units, sectionKey)) {
        mutations.push({
          id: randomUUID(),
          kind: "flag_conflict",
          risk: "high",
          confidence,
          summary: `Flag conflicting ${noteId}.${sectionKey}`,
          evidence: section.evidence ?? evidence,
          noteId,
          conflict: {
            field: sectionKey,
            existing: existingText,
            proposed: section.text,
            resolution: "pending",
            policy: "manual_review",
          },
        });
        continue;
      }

      if (shouldAppend(units, sectionKey, existing)) {
        mutations.push({
          id: randomUUID(),
          kind: "append_section",
          risk,
          confidence,
          summary: `Append ${noteId}.${sectionKey}`,
          evidence: section.evidence ?? evidence,
          noteId,
          sectionKey,
          text: section.text,
          salience: section.salience,
          gates: section.gates,
        });
      } else {
        mutations.push({
          id: randomUUID(),
          kind: "update_section",
          risk,
          confidence,
          summary: `Update ${noteId}.${sectionKey}`,
          evidence: section.evidence ?? evidence,
          noteId,
          sectionKey,
          section,
        });
      }
    }

    for (const link of links) {
      if (!existing.links.some((candidate) => candidate.target === link.target && candidate.relation === link.relation)) {
        mutations.push({
          id: randomUUID(),
          kind: "add_link",
          risk: "low",
          confidence,
          summary: `Link ${noteId} to ${link.target}`,
          evidence,
          noteId,
          link,
        });
      }
    }
  }

  return {
    summary: options.summary ?? `Compiled ${options.units.length} evidence unit(s) into ${mutations.length} draft mutation(s).`,
    mutations: mutations.slice(0, 25),
  };
}

function targetForUnit(unit: LtmEvidenceUnit): UnitTarget {
  const noteId = noteIdForEvidenceUnit(unit);
  const base = {
    noteId,
    sectionKey: unit.sectionKey,
    status: statusForUnit(unit),
  };
  if (unit.bucket.startsWith("relationship_")) {
    return { ...base, noteType: "relationship", tags: ["typed_memory", "relationship_memory"] };
  }
  if (unit.bucket === "thread") return { ...base, noteType: "thread", tags: ["typed_memory"] };
  if (unit.bucket === "callback") return { ...base, noteType: "callback", tags: ["typed_memory"] };
  if (unit.bucket === "world_fact") return { ...base, noteType: "world", tags: ["typed_memory"] };
  if (unit.bucket === "voice") return { ...base, noteType: "voice", tags: ["typed_memory"] };
  if (unit.bucket === "tone") return { ...base, noteType: "tone", tags: ["typed_memory"] };
  if (unit.bucket === "anchor") {
    const noteType: LtmNoteType = noteId.startsWith("tone_") ? "tone" : noteId.startsWith("cb_") ? "callback" : "world";
    return { ...base, noteType, tags: ["typed_memory", "anchor"] };
  }
  return { ...base, noteType: "character", tags: ["typed_memory"] };
}

function statusForUnit(unit: LtmEvidenceUnit): LtmStatus {
  if (unit.status === "developing") return "active";
  return unit.status;
}

function sectionsForUnits(units: LtmEvidenceUnit[], existing: LtmNote | undefined, timestamp: string) {
  const sections: Record<string, LtmSection> = {};
  for (const unit of units) {
    const sectionKey = sectionKeyForUnit(unit);
    const existingSection = existing?.sections[sectionKey];
    const text = unit.bucket === "relationship_event" ? eventLine(unit) : unit.text.trim();
    const baseText = unit.bucket === "relationship_event" ? sections[sectionKey]?.text : sections[sectionKey]?.text ?? existingSection?.text;
    sections[sectionKey] = {
      text: mergeSectionText(baseText, text, unit.bucket === "relationship_event"),
      updatedAt: timestamp,
      salience: Math.max(sections[sectionKey]?.salience ?? 0, unit.salience),
      confidence: Math.max(sections[sectionKey]?.confidence ?? 0, unit.confidence),
      evidence: uniqueStrings([...(sections[sectionKey]?.evidence ?? []), ...(existingSection?.evidence ?? []), ...unit.evidence]).slice(0, 100),
      gates: uniqueStrings([...(sections[sectionKey]?.gates ?? []), ...(existingSection?.gates ?? []), ...unit.gates]) as LtmSection["gates"],
    };
  }

  const relationshipUnits = units.filter((unit) => unit.bucket.startsWith("relationship_"));
  if (relationshipUnits.some((unit) => unit.bucket === "relationship_event" || unit.bucket === "relationship_state")) {
    const reduction = reduceRelationshipEvidenceUnits(relationshipUnits);
    const existingState = existing?.sections.state;
    sections.state = {
      text: formatRelationshipReduction(reduction),
      updatedAt: timestamp,
      salience: Math.max(existingState?.salience ?? 0, ...relationshipUnits.map((unit) => unit.salience)),
      confidence: Math.max(existingState?.confidence ?? 0, ...relationshipUnits.map((unit) => unit.confidence)),
      evidence: uniqueStrings([...(existingState?.evidence ?? []), ...relationshipUnits.flatMap((unit) => unit.evidence)]).slice(0, 100),
      gates: uniqueStrings([...(existingState?.gates ?? []), ...relationshipUnits.flatMap((unit) => unit.gates)]) as LtmSection["gates"],
    };
  }

  return sections;
}

function sectionKeyForUnit(unit: LtmEvidenceUnit) {
  if (unit.bucket === "relationship_event") return "history";
  if (unit.bucket === "relationship_state") return "state";
  if (unit.bucket === "character_state") return "current_state";
  if (unit.bucket === "character_fact") return unit.sectionKey || "facts";
  return unit.sectionKey;
}

function eventLine(unit: LtmEvidenceUnit) {
  return `- ${unit.text.trim()} [evidence:${unit.evidence.join(",")}]`;
}

function mergeSectionText(existing: string | undefined, incoming: string, append: boolean) {
  if (!existing?.trim()) return incoming.trim();
  if (!append) return incoming.trim();
  if (existing.includes(incoming.trim())) return existing.trim();
  return `${existing.trim()}\n${incoming.trim()}`;
}

function shouldAppend(units: LtmEvidenceUnit[], sectionKey: string, existing: LtmNote) {
  if (!existing.sections[sectionKey]) return false;
  return units.some((unit) => sectionKeyForUnit(unit) === sectionKey && unit.bucket === "relationship_event");
}

function isHighRiskOverwrite(units: LtmEvidenceUnit[], sectionKey: string) {
  return units
    .filter((unit) => sectionKeyForUnit(unit) === sectionKey)
    .some((unit) => riskForEvidenceUnit(unit) === "high" || unit.bucket === "character_fact" || unit.bucket === "world_fact");
}

function maxRisk(risks: LtmDraftRisk[]): LtmDraftRisk {
  if (risks.includes("high")) return "high";
  if (risks.includes("medium")) return "medium";
  return "low";
}

function uniqueStrings<T extends string>(values: T[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function uniqueLinks(links: LtmEvidenceUnit["links"]) {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.target}\0${link.relation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
