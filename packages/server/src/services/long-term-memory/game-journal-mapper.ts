import { createHash, randomUUID } from "node:crypto";
import type { LtmEvidenceUnit, LtmScope } from "@marinara-engine/shared";
import type { SessionSummary } from "@marinara-engine/shared";
import type { Journal, JournalEntry, QuestEntry } from "../game/journal.service.js";

export interface GameJournalMappingContext {
  chatId: string;
  scope: LtmScope;
  sourceHash: string;
}

function slugify(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 72);
  return normalized || fallback;
}

function unitBase(
  bucket: LtmEvidenceUnit["bucket"],
  subjectId: string,
  sectionKey: string,
  text: string,
  ctx: GameJournalMappingContext,
  extra: Partial<Omit<LtmEvidenceUnit, "id" | "bucket" | "subjectId" | "sectionKey" | "text" | "sourceHash">> = {},
): LtmEvidenceUnit {
  return {
    id: randomUUID(),
    bucket,
    subjectId,
    sectionKey,
    text: text.trim().slice(0, 2_000),
    keywords: [],
    evidence: extra.evidence ?? [`chat:${ctx.chatId}`],
    confidence: 0.95,
    salience: 0.7,
    importance: extra.importance ?? "moderate",
    status: extra.status ?? "active",
    links: extra.links ?? [],
    sourceHash: ctx.sourceHash,
  };
}

function mapQuestEntry(quest: QuestEntry, ctx: GameJournalMappingContext): LtmEvidenceUnit[] {
  const subjectId = `quest_${slugify(quest.id, "quest")}`;
  const evidence = [`journal_quest:${quest.id}`, `chat:${ctx.chatId}`];
  const objectivesText =
    quest.objectives.length > 0
      ? quest.objectives.map((obj, idx) => `${idx + 1}. ${obj}`).join("\n")
      : "";
  const text = [quest.name, quest.description, objectivesText, `Status: ${quest.status}`]
    .filter(Boolean)
    .join("\n");

  const status =
    quest.status === "active"
      ? ("active" as const)
      : quest.status === "completed"
        ? ("resolved" as const)
        : ("archived" as const);

  const sectionKey = quest.status === "active" ? "quest" : "summary";

  const unit = unitBase(
    "thread",
    subjectId,
    sectionKey,
    text,
    ctx,
    {
      evidence,
      status,
    },
  );

  return [unit];
}

function mapJournalEntry(entry: JournalEntry, idx: number, ctx: GameJournalMappingContext): LtmEvidenceUnit | null {
  const evidence = [`journal_entry:${entry.timestamp}`, `chat:${ctx.chatId}`];
  const slug = slugify(entry.title, `entry_${idx}`);

  switch (entry.type) {
    case "location": {
      const subjectId = `location_${slug}`;
      return unitBase("world_fact", subjectId, "discovered", entry.content, ctx, { evidence });
    }
    case "npc": {
      const subjectId = `npc_${slug}`;
      return unitBase("character_fact", subjectId, "facts", entry.content, ctx, { evidence });
    }
    case "combat": {
      const subjectId = `combat_${idx}_${slug}`;
      return unitBase("timeline_event", subjectId, "event", entry.content, ctx, { evidence });
    }
    case "item": {
      return unitBase("character_fact", "party_inventory", "items", entry.content, ctx, { evidence });
    }
    case "event": {
      const subjectId = `event_${idx}_${slug}`;
      return unitBase("timeline_event", subjectId, "event", entry.content, ctx, { evidence });
    }
    case "note": {
      const subjectId = `note_${slug}`;
      return unitBase("world_fact", subjectId, "notes", entry.content, ctx, { evidence });
    }
    case "quest":
      return null;
    default:
      return null;
  }
}

function mapInventoryLog(
  journal: Journal,
  ctx: GameJournalMappingContext,
): LtmEvidenceUnit[] {
  return journal.inventoryLog.map((entry, idx) => {
    const evidence = [`inventory_log:${entry.timestamp}`, `chat:${ctx.chatId}`];
    const text = `${entry.action === "acquired" ? "Acquired" : entry.action} ${entry.quantity}x ${entry.item}`;
    return unitBase("character_fact", "party_inventory", "items", text, ctx, {
      evidence,
      status: entry.action === "acquired" ? "active" : "resolved",
    });
  });
}

function mapNpcLog(
  journal: Journal,
  ctx: GameJournalMappingContext,
): LtmEvidenceUnit[] {
  return journal.npcLog.flatMap((npc) => {
    if (npc.interactions.length === 0) return [];
    const subjectId = `npc_${slugify(npc.npcName, "npc")}`;
    const evidence = [`npc_log:${npc.npcName}`, `chat:${ctx.chatId}`];
    const text = `${npc.npcName}: ${npc.interactions.join("; ")}`;
    return [
      unitBase("timeline_event", subjectId, "event", text, ctx, { evidence }),
    ];
  });
}

function mapLocations(
  journal: Journal,
  ctx: GameJournalMappingContext,
): LtmEvidenceUnit[] {
  if (journal.locations.length === 0) return [];
  const evidence = [`journal_locations`, `chat:${ctx.chatId}`];
  return journal.locations.map((location) => {
    const subjectId = `location_${slugify(location, "location")}`;
    return unitBase("world_fact", subjectId, "discovered", `Discovered: ${location}`, ctx, { evidence });
  });
}

function mapSessionSummary(summary: SessionSummary, ctx: GameJournalMappingContext): LtmEvidenceUnit[] {
  const units: LtmEvidenceUnit[] = [];
  const sessionEvidence = [`session:${summary.sessionNumber}`, `chat:${ctx.chatId}`];

  const hasSessionRecap = summary.summary.trim().length > 0;

  if (hasSessionRecap) {
    units.push(
      unitBase("timeline_event", `session_${summary.sessionNumber}`, "event", summary.summary, ctx, {
        evidence: sessionEvidence,
      }),
    );
  }

  if (summary.resumePoint.trim()) {
    units.push(
      unitBase("world_fact", `session_${summary.sessionNumber}_resume`, "resume_point", summary.resumePoint, ctx, {
        evidence: sessionEvidence,
      }),
    );
  }

  const sessionTimelineId = `timeline_session_${summary.sessionNumber}`;
  const partyLinks = hasSessionRecap
    ? [{ target: sessionTimelineId, relation: "caused_by" as const }]
    : undefined;

  if (summary.partyDynamics.trim()) {
    units.push(
      unitBase("relationship_state", "party", "state", summary.partyDynamics, ctx, {
        evidence: sessionEvidence,
        links: partyLinks,
      }),
    );
  }

  if (summary.partyState.trim()) {
    units.push(
      unitBase("character_fact", "party", "state", summary.partyState, ctx, {
        evidence: sessionEvidence,
      }),
    );
  }

  for (const discovery of summary.keyDiscoveries) {
    if (!discovery.trim()) continue;
    const slug = slugify(discovery, "discovery");
    units.push(
      unitBase("world_fact", `discovery_${slug}`, "discoveries", discovery, ctx, {
        evidence: sessionEvidence,
      }),
    );
  }

  for (const moment of summary.characterMoments) {
    if (!moment.trim()) continue;
    const slug = slugify(moment, "moment");
    units.push(
      unitBase("timeline_event", `char_${slug}`, "event", moment, ctx, {
        evidence: sessionEvidence,
      }),
    );
  }

  for (const detail of summary.littleDetails) {
    if (!detail.trim()) continue;
    const slug = slugify(detail, "detail");
    units.push(
      unitBase("character_fact", `char_${slug}`, "details", detail, ctx, {
        evidence: sessionEvidence,
      }),
    );
  }

  for (const update of summary.npcUpdates) {
    if (!update.trim()) continue;
    const slug = slugify(update, "npc_update");
    units.push(
      unitBase("timeline_event", `npc_${slug}`, "event", update, ctx, {
        evidence: sessionEvidence,
      }),
    );
  }

  if (summary.nextSessionRequest?.trim()) {
    units.push(
      unitBase("thread", `player_request_${summary.sessionNumber}`, "quest", summary.nextSessionRequest, ctx, {
        evidence: sessionEvidence,
        status: "active",
      }),
    );
  }

  return units;
}

export function mapGameJournalToEvidenceUnits(
  journal: Journal | null,
  summaries: SessionSummary[],
  ctx: GameJournalMappingContext,
): LtmEvidenceUnit[] {
  const units: LtmEvidenceUnit[] = [];

  if (journal) {
    for (const [idx, entry] of journal.entries.entries()) {
      const unit = mapJournalEntry(entry, idx, ctx);
      if (unit) units.push(unit);
    }
    for (const quest of journal.quests) {
      units.push(...mapQuestEntry(quest, ctx));
    }
    units.push(...mapLocations(journal, ctx));
    units.push(...mapNpcLog(journal, ctx));
    units.push(...mapInventoryLog(journal, ctx));
  }

  for (const summary of summaries) {
    units.push(...mapSessionSummary(summary, ctx));
  }

  return units;
}

export function computeGameSourceHash(
  journal: Journal | null,
  summaries: SessionSummary[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ journal, summaries }))
    .digest("hex");
}

export function renderGameSourceText(
  journal: Journal | null,
  summaries: SessionSummary[],
): string {
  const parts: string[] = [];

  if (journal) {
    if (journal.quests.length > 0) {
      parts.push(
        "Quests:\n" +
          journal.quests
            .map(
              (q) =>
                `- [${q.status}] ${q.name}: ${q.description}${q.objectives.length ? `\n  Objectives: ${q.objectives.join("; ")}` : ""}`,
            )
            .join("\n"),
      );
    }
    if (journal.locations.length > 0) {
      parts.push("Locations:\n" + journal.locations.map((l) => `- ${l}`).join("\n"));
    }
    if (journal.entries.length > 0) {
      parts.push(
        "Journal Entries:\n" +
          journal.entries.map((e) => `- [${e.type}] ${e.title}: ${e.content}`).join("\n"),
      );
    }
    if (journal.npcLog.length > 0) {
      parts.push(
        "NPC Log:\n" +
          journal.npcLog
            .map((n) => `- ${n.npcName}: ${n.interactions.join("; ")}`)
            .join("\n"),
      );
    }
    if (journal.inventoryLog.length > 0) {
      parts.push(
        "Inventory:\n" +
          journal.inventoryLog.map((i) => `- (${i.action}) ${i.quantity}x ${i.item}`).join("\n"),
      );
    }
  }

  for (const summary of summaries) {
    parts.push(
      `Session ${summary.sessionNumber}:\n` +
        `Summary: ${summary.summary}\n` +
        `Resume Point: ${summary.resumePoint}\n` +
        `Party State: ${summary.partyState}\n` +
        `Party Dynamics: ${summary.partyDynamics}` +
        (summary.keyDiscoveries.length
          ? `\nKey Discoveries:\n${summary.keyDiscoveries.map((d) => `- ${d}`).join("\n")}`
          : "") +
        (summary.characterMoments.length
          ? `\nCharacter Moments:\n${summary.characterMoments.map((m) => `- ${m}`).join("\n")}`
          : "") +
        (summary.littleDetails.length
          ? `\nLittle Details:\n${summary.littleDetails.map((d) => `- ${d}`).join("\n")}`
          : "") +
        (summary.npcUpdates.length
          ? `\nNPC Updates:\n${summary.npcUpdates.map((u) => `- ${u}`).join("\n")}`
          : ""),
    );
  }

  return parts.join("\n\n---\n\n").trim();
}
