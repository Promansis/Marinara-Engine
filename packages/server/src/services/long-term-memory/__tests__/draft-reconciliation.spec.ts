import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  LtmDraftMutation,
  LtmExtractionResponse,
  LtmNote,
} from "@marinara-engine/shared";
import { withConcurrency } from "../../../lib/concurrency.js";
import {
  projectLtmDraftOntoNotes,
  type LtmMutationDisposition,
} from "../draft-projector.js";
import { LongTermMemoryDraftStore } from "../draft-store.js";
import { readLtmIndexState } from "../index-state.js";
import {
  applyLongTermMemoryDraft,
  LtmDraftApplyError,
} from "../reconciliation.js";
import { finalizeLongTermMemoryExtractionDraft } from "../source-extraction.js";
import { LongTermMemoryStorage } from "../storage.js";

const timestamp = "2026-07-11T00:00:00.000Z";

async function withRoot(run: (root: string, storage: LongTermMemoryStorage) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-draft-reconciliation-"));
  try {
    await run(root, new LongTermMemoryStorage(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createSource(storage: LongTermMemoryStorage, id: string, text: string) {
  return storage.createNote(
    {
      id,
      type: "scene",
      status: "active",
      modes: ["roleplay"],
      scope: {},
      tags: ["source_summary"],
      links: [],
      sections: {
        source: {
          text,
          updatedAt: timestamp,
          evidence: [`source_note:${id}`],
        },
      },
    },
    { suppressEvent: true },
  );
}

function createCharacterMutation(sourceNoteId: string, text: string): LtmDraftMutation {
  return {
    id: randomUUID(),
    kind: "create_note",
    risk: "low",
    confidence: 0.9,
    summary: `Remember ${text}`,
    evidence: [`source_note:${sourceNoteId}`],
    note: {
      id: "char_damo",
      title: "Damo",
      type: "character",
      status: "active",
      modes: ["roleplay"],
      scope: {},
      tags: ["typed_memory"],
      keywords: ["Damo"],
      links: [],
      subjects: [{ key: "damo" }],
      sections: {
        facts: {
          text,
          updatedAt: timestamp,
          salience: 0.7,
          confidence: 0.8,
          importance: "major",
          evidence: [`source_note:${sourceNoteId}`],
        },
      },
    },
  };
}

function responseFor(mutation: LtmDraftMutation): LtmExtractionResponse {
  return { summary: mutation.summary, mutations: [mutation] };
}

function normalizedLines(text: string | undefined) {
  return new Set(
    (text ?? "")
      .split(/\r?\n/g)
      .map((line) => line.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
}

test("draft projector merges additive fields, rewrites current state, and reports dynamic dispositions", () => {
  const existing: LtmNote = {
    id: "char_damo",
    title: "Damo",
    type: "character",
    status: "active",
    modes: ["roleplay"],
    scope: {},
    tags: ["typed_memory"],
    keywords: ["Damo"],
    links: [],
    subjects: [{ key: "damo" }],
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    sections: {
      facts: {
        text: "Damo keeps careful watch.",
        updatedAt: timestamp,
        salience: 0.4,
        confidence: 0.5,
        importance: "minor",
        evidence: ["source_note:scene_source_a"],
      },
      inventory: {
        text: "A brass compass.",
        updatedAt: timestamp,
      },
    },
  };
  const mutations: LtmDraftMutation[] = [
    {
      id: randomUUID(),
      kind: "update_section",
      risk: "low",
      confidence: 0.95,
      summary: "Merge durable Damo facts",
      evidence: ["source_note:scene_source_b"],
      noteId: existing.id,
      sectionKey: "facts",
      section: {
        text: "damo keeps careful watch.\nDamo notices quiet acts of kindness.",
        updatedAt: timestamp,
        salience: 0.8,
        confidence: 0.9,
        importance: "critical",
        evidence: ["quote:kindness"],
      },
    },
    {
      id: randomUUID(),
      kind: "update_section",
      risk: "medium",
      confidence: 0.8,
      summary: "Rewrite current inventory",
      evidence: ["source_note:scene_source_b"],
      noteId: existing.id,
      sectionKey: "inventory",
      section: {
        text: "A silver compass.",
        updatedAt: timestamp,
      },
    },
    {
      id: randomUUID(),
      kind: "set_keywords",
      risk: "low",
      confidence: 0.9,
      summary: "Union keywords",
      evidence: ["source_note:scene_source_b"],
      noteId: existing.id,
      keywords: ["damo", "kindness"],
    },
  ];

  const projection = projectLtmDraftOntoNotes({
    notes: new Map([[existing.id, existing]]),
    mutations,
    context: {
      source: { sourceNoteId: "scene_source_b" },
      scope: {},
      modes: ["roleplay"],
    },
    timestamp: "2026-07-11T00:01:00.000Z",
  }).projections[0]!;

  assert.equal(
    projection.after.sections.facts?.text,
    "Damo keeps careful watch.\n\nDamo notices quiet acts of kindness.",
  );
  assert.equal(projection.after.sections.facts?.salience, 0.8);
  assert.equal(projection.after.sections.facts?.confidence, 0.95);
  assert.equal(projection.after.sections.facts?.importance, "critical");
  assert.deepEqual(
    new Set(projection.after.sections.facts?.evidence),
    new Set(["source_note:scene_source_a", "quote:kindness", "source_note:scene_source_b"]),
  );
  assert.equal(projection.after.sections.inventory?.text, "A silver compass.");
  assert.deepEqual(projection.after.keywords, ["Damo", "kindness"]);
  assert(
    projection.after.links.some(
      (link) => link.target === "scene_source_b" && link.relation === "extracted_from",
    ),
  );
  assert.deepEqual(
    projection.mutations.map((mutation) => mutation.disposition),
    ["merge", "rewrite", "merge"] satisfies LtmMutationDisposition[],
  );
});

test("batch finalization uses source order despite provider completion inversion and skips failed siblings", async () => {
  await withRoot(async (root, storage) => {
    const sourceA = await createSource(storage, "scene_source_a", "Damo keeps careful watch.");
    const sourceB = await createSource(storage, "scene_source_b", "A discarded candidate.");
    const sourceC = await createSource(storage, "scene_source_c", "Damo values quiet kindness.");
    const completionOrder: string[] = [];
    type PreparedResult =
      | { state: "prepared"; sourceNote: LtmNote; response: LtmExtractionResponse }
      | { state: "failed"; sourceNote: LtmNote };
    const tasks: Array<() => Promise<PreparedResult>> = [
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        completionOrder.push(sourceA.id);
        return {
          state: "prepared" as const,
          sourceNote: sourceA,
          response: responseFor(createCharacterMutation(sourceA.id, "Damo keeps careful watch.")),
        };
      },
      async () => {
        completionOrder.push(sourceB.id);
        return { state: "failed" as const, sourceNote: sourceB };
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        completionOrder.push(sourceC.id);
        return {
          state: "prepared" as const,
          sourceNote: sourceC,
          response: responseFor(createCharacterMutation(sourceC.id, "Damo values quiet kindness.")),
        };
      },
    ];

    const prepared = await withConcurrency(tasks, 3);
    assert.deepEqual(completionOrder, [sourceB.id, sourceC.id, sourceA.id]);
    assert.deepEqual(prepared.map((result) => result.sourceNote.id), [sourceA.id, sourceB.id, sourceC.id]);

    const overlay = new Map<string, LtmNote>();
    for (const result of prepared) {
      if (result.state !== "prepared") continue;
      await finalizeLongTermMemoryExtractionDraft(
        {
          sourceNote: result.sourceNote,
          response: result.response,
          scope: result.sourceNote.scope,
          modes: result.sourceNote.modes,
        },
        { root, overlay },
      );
    }

    assert.equal(
      overlay.get("char_damo")?.sections.facts?.text,
      "Damo keeps careful watch.\n\nDamo values quiet kindness.",
    );
    assert(!overlay.get("char_damo")?.sections.facts?.text.includes("discarded"));
    assert.equal((await new LongTermMemoryDraftStore(root).listDrafts({ status: "pending" })).length, 2);
  });
});

test("same-source re-extraction supersedes older pending drafts", async () => {
  await withRoot(async (root, storage) => {
    const source = await createSource(storage, "scene_source_supersede", "Damo remains considerate.");
    const store = new LongTermMemoryDraftStore(root);
    const first = await store.createDraft({
      source: { sourceNoteId: source.id },
      scope: {},
      modes: ["roleplay"],
      response: responseFor(createCharacterMutation(source.id, "Damo remains considerate.")),
    });
    const second = await store.createDraft({
      source: { sourceNoteId: source.id },
      scope: {},
      modes: ["roleplay"],
      response: responseFor(createCharacterMutation(source.id, "Damo notices quiet kindness.")),
    });

    const persistedFirst = await store.getDraft(first.id);
    assert.equal(persistedFirst?.status, "superseded");
    assert.equal(persistedFirst?.supersededByDraftId, second.id);
    assert(persistedFirst?.supersededAt);
    await assert.rejects(
      applyLongTermMemoryDraft(first.id, { root, rebuildIndexes: false }),
      (error: unknown) =>
        error instanceof LtmDraftApplyError &&
        error.statusCode === 409 &&
        error.code === "ltm_draft_superseded",
    );
    assert.equal((await store.getDraft(second.id))?.status, "pending");
  });
});

test("concurrent sibling acceptance rebases inside the note lock without losing facts", async () => {
  await withRoot(async (root, storage) => {
    const sourceA = await createSource(storage, "scene_source_concurrent_a", "Damo keeps careful watch.");
    const sourceB = await createSource(storage, "scene_source_concurrent_b", "Damo values quiet kindness.");
    const store = new LongTermMemoryDraftStore(root);
    const first = await store.createDraft({
      source: { sourceNoteId: sourceA.id },
      scope: {},
      modes: ["roleplay"],
      response: responseFor(createCharacterMutation(sourceA.id, "Damo keeps careful watch.")),
    });
    const second = await store.createDraft({
      source: { sourceNoteId: sourceB.id },
      scope: {},
      modes: ["roleplay"],
      response: responseFor(createCharacterMutation(sourceB.id, "Damo values quiet kindness.")),
    });

    const results = await Promise.all([
      applyLongTermMemoryDraft(first.id, { root, rebuildIndexes: false }),
      applyLongTermMemoryDraft(second.id, { root, rebuildIndexes: false }),
    ]);
    assert(results.every((result) => result.appliedMutationIds.length === 1));
    assert.deepEqual(
      normalizedLines((await storage.getNote("char_damo"))?.sections.facts?.text),
      new Set(["damo keeps careful watch.", "damo values quiet kindness."]),
    );
  });
});

test("additive acceptance preserves the same facts in either acceptance order", async () => {
  async function acceptInOrder(reverse: boolean) {
    let facts = new Set<string>();
    await withRoot(async (root, storage) => {
      const sourceA = await createSource(storage, "scene_source_order_a", "Damo keeps careful watch.");
      const sourceB = await createSource(storage, "scene_source_order_b", "Damo values quiet kindness.");
      const store = new LongTermMemoryDraftStore(root);
      const drafts = [
        await store.createDraft({
          source: { sourceNoteId: sourceA.id },
          scope: {},
          modes: ["roleplay"],
          response: responseFor(createCharacterMutation(sourceA.id, "Damo keeps careful watch.")),
        }),
        await store.createDraft({
          source: { sourceNoteId: sourceB.id },
          scope: {},
          modes: ["roleplay"],
          response: responseFor(createCharacterMutation(sourceB.id, "Damo values quiet kindness.")),
        }),
      ];
      for (const draft of reverse ? drafts.reverse() : drafts) {
        await applyLongTermMemoryDraft(draft.id, { root, rebuildIndexes: false });
      }
      facts = normalizedLines((await storage.getNote("char_damo"))?.sections.facts?.text);
    });
    return facts;
  }

  assert.deepEqual(await acceptInOrder(false), await acceptInOrder(true));
});

test("stale and missing source hashes reject before target or index writes", async () => {
  await withRoot(async (root, storage) => {
    const source = await createSource(storage, "scene_source_stale", "Damo keeps careful watch.");
    const store = new LongTermMemoryDraftStore(root);
    const staleDraft = await store.createDraft({
      source: { sourceNoteId: source.id },
      scope: {},
      modes: ["roleplay"],
      response: responseFor(createCharacterMutation(source.id, "Damo keeps careful watch.")),
    });
    await storage.updateNote(source.id, {
      sections: {
        ...source.sections,
        source: { ...source.sections.source!, text: "Damo changed after extraction." },
      },
    });
    const staleRevision = (await readLtmIndexState(root)).revision;

    await assert.rejects(
      applyLongTermMemoryDraft(staleDraft.id, { root, rebuildIndexes: false }),
      (error: unknown) =>
        error instanceof LtmDraftApplyError &&
        error.statusCode === 409 &&
        error.code === "ltm_draft_source_stale",
    );
    assert.equal(await storage.getNote("char_damo"), null);
    assert.equal((await readLtmIndexState(root)).revision, staleRevision);

    const missingSource = await createSource(storage, "scene_source_missing", "Damo remembers the archive.");
    const missingDraft = await store.createDraft({
      source: { sourceNoteId: missingSource.id },
      scope: {},
      modes: ["roleplay"],
      response: responseFor(createCharacterMutation(missingSource.id, "Damo remembers the archive.")),
    });
    await storage.deleteNote(missingSource.id, { suppressEvent: true });
    const missingRevision = (await readLtmIndexState(root)).revision;
    await assert.rejects(
      applyLongTermMemoryDraft(missingDraft.id, { root, rebuildIndexes: false }),
      (error: unknown) =>
        error instanceof LtmDraftApplyError &&
        error.statusCode === 409 &&
        error.code === "ltm_draft_source_missing",
    );
    assert.equal(await storage.getNote("char_damo"), null);
    assert.equal((await readLtmIndexState(root)).revision, missingRevision);
  });
});

test("hashless legacy drafts require manual confirmation and cannot auto-apply", async () => {
  await withRoot(async (root, storage) => {
    const source = await createSource(storage, "scene_source_hashless", "Damo keeps careful watch.");
    const store = new LongTermMemoryDraftStore(root);
    const draft = await store.createDraft({
      source: { sourceNoteId: source.id },
      scope: {},
      modes: ["roleplay"],
      response: responseFor(createCharacterMutation(source.id, "Damo keeps careful watch.")),
    });
    const hashless = await store.updateDraft(draft.id, {
      source: { sourceNoteId: source.id },
    });
    assert.equal(hashless?.source.sourceHash, undefined);

    await assert.rejects(
      applyLongTermMemoryDraft(draft.id, {
        root,
        autoApplyLowRiskOnly: true,
        rebuildIndexes: false,
      }),
      (error: unknown) =>
        error instanceof LtmDraftApplyError &&
        error.statusCode === 409 &&
        error.code === "ltm_draft_source_hash_confirmation_required",
    );
    assert.equal(await storage.getNote("char_damo"), null);

    const manual = await applyLongTermMemoryDraft(draft.id, { root, rebuildIndexes: false });
    assert.equal(manual.draft.status, "accepted");
    assert.equal((await storage.getNote("char_damo"))?.sections.facts?.text, "Damo keeps careful watch.");
  });
});

test("projection limit failures block the target write instead of truncating", async () => {
  await withRoot(async (root, storage) => {
    const source = await createSource(storage, "scene_source_limit", "Damo gains one more durable fact.");
    await storage.createNote(
      {
        id: "char_damo",
        title: "Damo",
        type: "character",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        keywords: [],
        links: [],
        subjects: [{ key: "damo" }],
        sections: {
          facts: {
            text: "a".repeat(19_998),
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    const before = await storage.getNote("char_damo");
    const mutation: LtmDraftMutation = {
      id: randomUUID(),
      kind: "append_section",
      risk: "low",
      confidence: 0.9,
      summary: "Append one fact beyond the section limit",
      evidence: [`source_note:${source.id}`],
      noteId: "char_damo",
      sectionKey: "facts",
      text: "b",
    };
    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      source: { sourceNoteId: source.id },
      scope: {},
      modes: ["roleplay"],
      response: responseFor(mutation),
    });

    await assert.rejects(
      applyLongTermMemoryDraft(draft.id, { root, rebuildIndexes: false }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "LtmDraftProjectionError" &&
        (error as { code?: string }).code === "projection_limit_exceeded",
    );
    assert.deepEqual(await storage.getNote("char_damo"), before);
  });
});
