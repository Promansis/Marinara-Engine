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

type LtmCompilerLifecycle =
  | "cumulative"
  | "superseding"
  | "rolling_until_resolved";

const LTM_BUCKET_LIFECYCLE: Record<LtmEvidenceUnit["bucket"], LtmCompilerLifecycle> = {
  timeline_event: "cumulative",
  character_fact: "superseding",
  character_state: "superseding",
  relationship_event: "cumulative",
  relationship_state: "superseding",
  relationship_conflict: "superseding",
  world_fact: "superseding",
  thread: "rolling_until_resolved",
  tone: "superseding",
  anchor: "cumulative",
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
      const lifecycle = lifecycleForSection(units, sectionKey);
      if (shouldAppend(lifecycle, sectionKey, existing)) {
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

    const nextStatus = statusForUnits(units);
    if (nextStatus !== existing.status && shouldSetStatus(units, existing.status, nextStatus)) {
      mutations.push({
        id: randomUUID(),
        kind: "set_status",
        risk,
        confidence,
        summary: `Set ${noteId} status to ${nextStatus}`,
        evidence,
        noteId,
        status: nextStatus,
      });
    }

    for (const link of links) {
      if (
        !existing.links.some((candidate) => candidate.target === link.target && candidate.relation === link.relation)
      ) {
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
    summary:
      options.summary ??
      `Compiled ${options.units.length} evidence unit(s) into ${mutations.length} draft mutation(s).`,
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
  if (unit.bucket === "timeline_event") {
    return { ...base, noteType: "timeline_event", tags: ["typed_memory", "timeline_event"] };
  }
  if (unit.bucket === "thread") return { ...base, noteType: "thread", tags: ["typed_memory"] };
  if (unit.bucket === "world_fact") return { ...base, noteType: "world", tags: ["typed_memory"] };
  if (unit.bucket === "tone") return { ...base, noteType: "tone", tags: ["typed_memory"] };
  if (unit.bucket === "anchor") {
    const noteType: LtmNoteType = noteId.startsWith("tone_") ? "tone" : "world";
    return { ...base, noteType, tags: ["typed_memory", "anchor"] };
  }
  return { ...base, noteType: "character", tags: ["typed_memory"] };
}

function statusForUnit(unit: LtmEvidenceUnit): LtmStatus {
  if (isResolvedLoopUnit(unit)) return "archived";
  if (unit.status === "developing") return "active";
  return unit.status;
}

function sectionsForUnits(units: LtmEvidenceUnit[], existing: LtmNote | undefined, timestamp: string) {
  const sections: Record<string, LtmSection> = {};
  for (const unit of units) {
    const sectionKey = sectionKeyForUnit(unit);
    const existingSection = existing?.sections[sectionKey];
    const lifecycle = LTM_BUCKET_LIFECYCLE[unit.bucket];
    const text = lifecycle === "cumulative" ? cumulativeLine(unit) : unit.text.trim();
    const baseText = sections[sectionKey]?.text;
    sections[sectionKey] = {
      text: mergeSectionText(baseText, text, lifecycle === "cumulative"),
      updatedAt: timestamp,
      salience: Math.max(sections[sectionKey]?.salience ?? 0, unit.salience),
      confidence: Math.max(sections[sectionKey]?.confidence ?? 0, unit.confidence),
      evidence: uniqueStrings([
        ...(sections[sectionKey]?.evidence ?? []),
        ...(existingSection?.evidence ?? []),
        ...unit.evidence,
      ]).slice(0, 100),
    };
  }

  const toneUnits = units.filter((unit) => unit.bucket === "tone");
  if (toneUnits.length > 0) {
    const existingObservations = examplesFromSection(existing?.sections.observations?.text);
    const incomingObservations = uniqueStrings(toneUnits.map((unit) => unit.text.trim()).filter(Boolean));
    const observations = uniqueStrings([...existingObservations, ...incomingObservations]).slice(-8);
    const evidence = uniqueStrings([
      ...(existing?.sections.profile?.evidence ?? []),
      ...(existing?.sections.observations?.evidence ?? []),
      ...toneUnits.flatMap((unit) => unit.evidence),
    ]).slice(0, 100);
    sections.observations = {
      text: observations.map((observation) => `- ${observation}`).join("\n"),
      updatedAt: timestamp,
      salience: Math.max(existing?.sections.observations?.salience ?? 0, ...toneUnits.map((unit) => unit.salience)),
      confidence: Math.max(
        existing?.sections.observations?.confidence ?? 0,
        ...toneUnits.map((unit) => unit.confidence),
      ),
      evidence,
    };
    sections.profile = {
      text: deriveToneProfile(observations),
      updatedAt: timestamp,
      salience: Math.max(existing?.sections.profile?.salience ?? 0, ...toneUnits.map((unit) => unit.salience)),
      confidence: Math.max(existing?.sections.profile?.confidence ?? 0, ...toneUnits.map((unit) => unit.confidence)),
      evidence,
    };
  }

  return sections;
}

function sectionKeyForUnit(unit: LtmEvidenceUnit) {
  if (unit.bucket === "timeline_event") return unit.sectionKey || "event";
  if (unit.bucket === "relationship_event") return "history";
  if (unit.bucket === "relationship_state") return "state";
  if (unit.bucket === "character_state") return "current_state";
  if (unit.bucket === "character_fact") return unit.sectionKey || "facts";
  if (unit.bucket === "tone") return "observations";
  if ((unit.bucket === "thread") && unit.status === "resolved") return "summary";
  return unit.sectionKey;
}

function cumulativeLine(unit: LtmEvidenceUnit) {
  return `- ${unit.text.trim()}`;
}

function mergeSectionText(existing: string | undefined, incoming: string, append: boolean) {
  if (!existing?.trim()) return incoming.trim();
  if (!append) return incoming.trim();
  if (existing.includes(incoming.trim())) return existing.trim();
  return `${existing.trim()}\n${incoming.trim()}`;
}

function examplesFromSection(text: string | undefined) {
  if (!text?.trim()) return [];
  return text
    .split(/\r?\n+/)
    .map((line) => line.trim().replace(/^-\s*/, ""))
    .filter(Boolean);
}

function deriveToneProfile(observations: string[]) {
  const sample = observations.slice(-3).map(compactProfileFragment).join("; ");
  return sample ? `Tone profile: ${sample}.` : "Tone profile: keep the established tone consistent.";
}

function compactProfileFragment(text: string) {
  return text
    .replace(/\s+/g, " ")
    .replace(/^["']|["']$/g, "")
    .trim()
    .slice(0, 180);
}

function lifecycleForSection(units: LtmEvidenceUnit[], sectionKey: string): LtmCompilerLifecycle {
  const lifecycles = units
    .filter((unit) => sectionKeyForUnit(unit) === sectionKey)
    .map((unit) => LTM_BUCKET_LIFECYCLE[unit.bucket]);
  if (lifecycles.includes("cumulative")) return "cumulative";
  if (lifecycles.includes("rolling_until_resolved")) return "rolling_until_resolved";
  return "superseding";
}

function shouldAppend(lifecycle: LtmCompilerLifecycle, sectionKey: string, existing: LtmNote) {
  if (!existing.sections[sectionKey]) return false;
  return lifecycle === "cumulative";
}

function statusForUnits(units: LtmEvidenceUnit[]) {
  if (units.some((unit) => unit.status === "archived")) return "archived";
  if (units.some(isResolvedLoopUnit)) return "archived";
  if (units.some((unit) => unit.status === "resolved")) return "resolved";
  if (units.some((unit) => unit.status === "active" || unit.status === "developing")) return "active";
  return "active";
}

function shouldSetStatus(units: LtmEvidenceUnit[], existingStatus: LtmStatus, nextStatus: LtmStatus) {
  if (existingStatus === "archived") return false;
  return units.some((unit) => LTM_BUCKET_LIFECYCLE[unit.bucket] === "rolling_until_resolved");
}

function isResolvedLoopUnit(unit: LtmEvidenceUnit) {
  return unit.bucket === "thread" && unit.status === "resolved";
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
