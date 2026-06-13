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

type LtmCompilerLifecycle =
  | "cumulative"
  | "superseding"
  | "superseding_conflict_review"
  | "rolling_until_resolved"
  | "manual_conflict";

const LTM_BUCKET_LIFECYCLE: Record<LtmEvidenceUnit["bucket"], LtmCompilerLifecycle> = {
  timeline_event: "cumulative",
  character_fact: "superseding_conflict_review",
  character_state: "superseding",
  relationship_event: "cumulative",
  relationship_state: "superseding",
  relationship_conflict: "manual_conflict",
  world_fact: "superseding_conflict_review",
  thread: "rolling_until_resolved",
  callback: "rolling_until_resolved",
  voice: "cumulative",
  tone: "superseding",
  anchor: "cumulative",
};

const CUMULATIVE_LINE_PATTERN = /^-\s*(?<text>.*?)(?:\s*\[evidence:(?<evidence>[^\]]*)\])?$/;

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
      gates: uniqueStrings([
        ...(sections[sectionKey]?.gates ?? []),
        ...(existingSection?.gates ?? []),
        ...unit.gates,
      ]) as LtmSection["gates"],
    };
  }

  const relationshipUnits = units.filter((unit) => unit.bucket.startsWith("relationship_"));
  if (relationshipUnits.some((unit) => unit.bucket === "relationship_event" || unit.bucket === "relationship_state")) {
    const reduction = reduceRelationshipEvidenceUnits([
      ...relationshipUnitsFromExistingNote(existing),
      ...relationshipUnits.filter(
        (unit) => unit.bucket === "relationship_event" || unit.bucket === "relationship_state",
      ),
    ]);
    const existingState = existing?.sections.state;
    sections.state = {
      text: formatRelationshipReduction(reduction),
      updatedAt: timestamp,
      salience: Math.max(existingState?.salience ?? 0, ...relationshipUnits.map((unit) => unit.salience)),
      confidence: Math.max(existingState?.confidence ?? 0, ...relationshipUnits.map((unit) => unit.confidence)),
      evidence: uniqueStrings([
        ...(existingState?.evidence ?? []),
        ...relationshipUnits.flatMap((unit) => unit.evidence),
      ]).slice(0, 100),
      gates: uniqueStrings([
        ...(existingState?.gates ?? []),
        ...relationshipUnits.flatMap((unit) => unit.gates),
      ]) as LtmSection["gates"],
    };
  }

  const voiceUnits = units.filter((unit) => unit.bucket === "voice");
  if (voiceUnits.length > 0) {
    const existingExamples = examplesFromSection(existing?.sections.examples?.text);
    const incomingExamples = uniqueStrings(voiceUnits.map((unit) => unit.text.trim()).filter(Boolean));
    const examples = uniqueStrings([...existingExamples, ...incomingExamples]).slice(-8);
    const sectionExamples = existing
      ? incomingExamples.filter((example) => !existingExamples.includes(example))
      : examples;
    const evidence = uniqueStrings([
      ...(existing?.sections.profile?.evidence ?? []),
      ...(existing?.sections.examples?.evidence ?? []),
      ...voiceUnits.flatMap((unit) => unit.evidence),
    ]).slice(0, 100);
    const gates = uniqueStrings([
      ...(existing?.sections.profile?.gates ?? []),
      ...(existing?.sections.examples?.gates ?? []),
      ...voiceUnits.flatMap((unit) => unit.gates),
    ]) as LtmSection["gates"];
    if (sectionExamples.length > 0 || !existing?.sections.examples) {
      sections.examples = {
        text: sectionExamples.map((example) => `- ${example}`).join("\n"),
        updatedAt: timestamp,
        salience: Math.max(existing?.sections.examples?.salience ?? 0, ...voiceUnits.map((unit) => unit.salience)),
        confidence: Math.max(
          existing?.sections.examples?.confidence ?? 0,
          ...voiceUnits.map((unit) => unit.confidence),
        ),
        evidence,
        gates,
      };
    } else {
      delete sections.examples;
    }
    sections.profile = {
      text: deriveVoiceProfile(examples),
      updatedAt: timestamp,
      salience: Math.max(existing?.sections.profile?.salience ?? 0, ...voiceUnits.map((unit) => unit.salience)),
      confidence: Math.max(existing?.sections.profile?.confidence ?? 0, ...voiceUnits.map((unit) => unit.confidence)),
      evidence,
      gates,
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
    const gates = uniqueStrings([
      ...(existing?.sections.profile?.gates ?? []),
      ...(existing?.sections.observations?.gates ?? []),
      ...toneUnits.flatMap((unit) => unit.gates),
    ]) as LtmSection["gates"];
    sections.observations = {
      text: observations.map((observation) => `- ${observation}`).join("\n"),
      updatedAt: timestamp,
      salience: Math.max(existing?.sections.observations?.salience ?? 0, ...toneUnits.map((unit) => unit.salience)),
      confidence: Math.max(
        existing?.sections.observations?.confidence ?? 0,
        ...toneUnits.map((unit) => unit.confidence),
      ),
      evidence,
      gates,
    };
    sections.profile = {
      text: deriveToneProfile(observations),
      updatedAt: timestamp,
      salience: Math.max(existing?.sections.profile?.salience ?? 0, ...toneUnits.map((unit) => unit.salience)),
      confidence: Math.max(existing?.sections.profile?.confidence ?? 0, ...toneUnits.map((unit) => unit.confidence)),
      evidence,
      gates,
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
  if (unit.bucket === "voice") return "examples";
  if (unit.bucket === "tone") return "observations";
  if ((unit.bucket === "thread" || unit.bucket === "callback") && unit.status === "resolved") return "summary";
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

function relationshipUnitsFromExistingNote(existing: LtmNote | undefined): LtmEvidenceUnit[] {
  if (!existing || existing.type !== "relationship") return [];
  const history = existing.sections.history?.text;
  if (!history?.trim()) return [];

  const units: LtmEvidenceUnit[] = [];
  for (const [index, line] of history.split(/\r?\n+/).entries()) {
    const parsed = parseCumulativeLine(line);
    if (!parsed?.text) continue;
    units.push({
      id: randomUUID(),
      bucket: "relationship_event",
      subjectId: existing.id.replace(/^rel_/, ""),
      sectionKey: `existing_${String(index).padStart(4, "0")}`,
      text: parsed.text,
      evidence: parsed.evidence.length
        ? parsed.evidence
        : (existing.sections.history?.evidence ?? ["existing_history"]),
      confidence: existing.sections.history?.confidence ?? 0.6,
      salience: existing.sections.history?.salience ?? 0.6,
      status: existing.status === "dormant" ? "active" : existing.status,
      gates: existing.sections.history?.gates ?? [],
      links: [],
      sourceHash: "0".repeat(64),
    });
  }
  return units;
}

function parseCumulativeLine(line: string) {
  const match = line.trim().match(CUMULATIVE_LINE_PATTERN);
  if (!match?.groups) return null;
  return {
    text: match.groups.text?.trim() ?? "",
    evidence: uniqueStrings((match.groups.evidence ?? "").split(",").map((item) => item.trim())),
  };
}

function examplesFromSection(text: string | undefined) {
  if (!text?.trim()) return [];
  return text
    .split(/\r?\n+/)
    .map((line) => line.trim().replace(/^-\s*/, ""))
    .filter(Boolean);
}

function deriveVoiceProfile(examples: string[]) {
  const sample = examples.slice(-3).map(compactProfileFragment).join("; ");
  return sample
    ? `Voice profile: ${sample}.`
    : "Voice profile: keep responses concise and consistent with established speech examples.";
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
  if (lifecycles.includes("superseding_conflict_review")) return "superseding_conflict_review";
  if (lifecycles.includes("manual_conflict")) return "manual_conflict";
  return "superseding";
}

function shouldAppend(lifecycle: LtmCompilerLifecycle, sectionKey: string, existing: LtmNote) {
  if (!existing.sections[sectionKey]) return false;
  return lifecycle === "cumulative";
}

function isHighRiskOverwrite(units: LtmEvidenceUnit[], sectionKey: string) {
  return units
    .filter((unit) => sectionKeyForUnit(unit) === sectionKey)
    .some(
      (unit) =>
        riskForEvidenceUnit(unit) === "high" || LTM_BUCKET_LIFECYCLE[unit.bucket] === "superseding_conflict_review",
    );
}

function statusForUnits(units: LtmEvidenceUnit[]) {
  if (units.some((unit) => unit.status === "archived")) return "archived";
  if (units.some(isResolvedLoopUnit)) return "archived";
  if (units.some((unit) => unit.status === "resolved")) return "resolved";
  if (units.some((unit) => unit.status === "active" || unit.status === "developing")) return "active";
  return "dormant";
}

function shouldSetStatus(units: LtmEvidenceUnit[], existingStatus: LtmStatus, nextStatus: LtmStatus) {
  if (existingStatus === "archived") return false;
  return units.some((unit) => LTM_BUCKET_LIFECYCLE[unit.bucket] === "rolling_until_resolved");
}

function isResolvedLoopUnit(unit: LtmEvidenceUnit) {
  return (unit.bucket === "thread" || unit.bucket === "callback") && unit.status === "resolved";
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
