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
import {
  ltmDraftReviewResponseSchema,
  ltmExtractionAccountingSchema,
} from "@marinara-engine/shared";
import { withConcurrency } from "../../../lib/concurrency.js";
import {
  projectLtmDraftOntoNotes,
  type LtmMutationDisposition,
} from "../draft-projector.js";
import { LongTermMemoryDraftStore } from "../draft-store.js";
import { projectLongTermMemoryDraftReview } from "../draft-review.js";
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

test("extraction accounting rejects unbalanced candidate dispositions", () => {
  assert.equal(
    ltmExtractionAccountingSchema.safeParse({
      providerCandidates: 2,
      normalizedAdditions: 1,
      parserRejections: 0,
      validationRejections: 1,
      deduplications: 0,
      keptUnits: 1,
    }).success,
    false,
  );
  assert.equal(
    ltmExtractionAccountingSchema.safeParse({
      providerCandidates: 2,
      normalizedAdditions: 1,
      parserRejections: 0,
      validationRejections: 1,
      deduplications: 1,
      keptUnits: 1,
    }).success,
    true,
  );
});

test("draft Review groups targets, projects dynamic dispositions, and preserves diagnostics", async () => {
  await withRoot(async (root, storage) => {
    const sourceA = await createSource(storage, "scene_review_source_a", "Damo keeps careful watch.");
    const sourceB = await createSource(storage, "scene_review_source_b", "Damo values quiet kindness.");
    const sourceC = await createSource(storage, "scene_review_source_c", "A malformed candidate was returned.");
    const store = new LongTermMemoryDraftStore(root);
    const mutationA = createCharacterMutation(sourceA.id, "Damo keeps careful watch.");
    const mutationB = createCharacterMutation(sourceB.id, "Damo values quiet kindness.");

    const draftA = await store.createDraft({
      source: { sourceNoteId: sourceA.id },
      scope: {},
      modes: ["roleplay"],
      response: responseFor(mutationA),
      operationId: randomUUID(),
      diagnostics: [
        {
          severity: "warning",
          code: "mutation_needs_review",
          mutationId: mutationA.id,
          message: "Confirm this durable character fact.",
        },
      ],
      outcome: {
        state: "success",
        totalCandidates: 1,
        keptUnits: 1,
        droppedUnits: 0,
        droppedCandidates: [],
      },
      accounting: {
        providerCandidates: 1,
        normalizedAdditions: 0,
        parserRejections: 0,
        validationRejections: 0,
        deduplications: 0,
        keptUnits: 1,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const draftB = await store.createDraft({
      source: { sourceNoteId: sourceB.id },
      scope: {},
      modes: ["roleplay"],
      response: responseFor(mutationB),
      operationId: randomUUID(),
      diagnostics: [
        {
          severity: "error",
          code: "composite_character_subject",
          candidateIndex: 1,
          message: "A composite character subject could not be bound.",
        },
        {
          severity: "warning",
          code: "deduplicated_evidence_unit",
          candidateIndex: 2,
          message: "A repeated fact was deduplicated.",
        },
      ],
      outcome: {
        state: "partial_success",
        totalCandidates: 3,
        keptUnits: 1,
        droppedUnits: 2,
        droppedCandidates: [
          {
            index: 1,
            reason: "invalid_subject_cardinality",
            message: "A composite character subject could not be bound.",
          },
        ],
      },
      accounting: {
        providerCandidates: 3,
        normalizedAdditions: 0,
        parserRejections: 0,
        validationRejections: 1,
        deduplications: 1,
        keptUnits: 1,
      },
    });
    const diagnosticDraft = await store.createDraft({
      source: { sourceNoteId: sourceC.id },
      scope: {},
      modes: ["roleplay"],
      response: { summary: "No mutation survived.", mutations: [] },
      operationId: randomUUID(),
      diagnostics: [
        {
          severity: "error",
          code: "candidate_parse_failed",
          candidateIndex: 0,
          message: "The provider candidate was malformed.",
        },
      ],
      outcome: {
        state: "no_suggestions_created",
        totalCandidates: 1,
        keptUnits: 0,
        droppedUnits: 1,
        droppedCandidates: [
          {
            index: 0,
            reason: "invalid_format",
            message: "The provider candidate was malformed.",
          },
        ],
      },
      accounting: {
        providerCandidates: 1,
        normalizedAdditions: 0,
        parserRejections: 1,
        validationRejections: 0,
        deduplications: 0,
        keptUnits: 0,
      },
    });

    await storage.updateNote(sourceB.id, {
      sections: {
        ...sourceB.sections,
        source: { ...sourceB.sections.source!, text: "Damo changed after extraction." },
      },
    });

    const review = ltmDraftReviewResponseSchema.parse(await projectLongTermMemoryDraftReview({ root }));
    assert.equal(review.counts.sources, 3);
    assert.equal(review.counts.drafts, 3);
    assert.equal(review.counts.mutations, 2);
    assert.equal(review.counts.blockedDrafts, 2);
    assert.equal(review.counts.candidateRejections, 2);
    assert.equal(review.counts.deduplications, 1);

    const sourceReviewA = review.sources.find((source) => source.sourceNoteId === sourceA.id)!;
    const sourceReviewB = review.sources.find((source) => source.sourceNoteId === sourceB.id)!;
    const sourceReviewC = review.sources.find((source) => source.sourceNoteId === sourceC.id)!;
    assert.equal(sourceReviewA.targets[0]?.noteId, "char_damo");
    assert.equal(sourceReviewA.targets[0]?.rows[0]?.disposition, "new");
    assert.equal(sourceReviewA.targets[0]?.rows[0]?.diagnostics[0]?.code, "mutation_needs_review");
    assert.equal(sourceReviewB.targets[0]?.rows[0]?.disposition, "merge");
    assert.deepEqual(sourceReviewB.targets[0]?.rows[0]?.changes.map((change) => change.key), ["facts"]);
    assert.equal(sourceReviewB.drafts[0]?.freshness, "stale");
    assert.deepEqual(sourceReviewB.drafts[0]?.blockReasons.map((reason) => reason.code), ["source_stale"]);
    assert.equal(sourceReviewB.drafts[0]?.diagnostics[0]?.code, "composite_character_subject");
    assert.equal(sourceReviewB.drafts[0]?.deduplications[0]?.code, "deduplicated_evidence_unit");
    assert.equal(sourceReviewC.targets.length, 0);
    assert.deepEqual(sourceReviewC.drafts[0]?.blockReasons.map((reason) => reason.code), ["no_mutations"]);
    assert.equal(sourceReviewC.drafts[0]?.diagnostics[0]?.code, "candidate_parse_failed");
    assert.deepEqual(
      await store.getDraft(diagnosticDraft.id),
      sourceReviewC.drafts[0]?.draft,
    );
    assert.equal(sourceReviewA.drafts[0]?.draft.id, draftA.id);
    assert.equal(sourceReviewB.drafts[0]?.draft.id, draftB.id);

    const filteredReview = await projectLongTermMemoryDraftReview({ root, sourceNoteId: sourceB.id });
    assert.deepEqual(filteredReview.sources.map((source) => source.sourceNoteId), [sourceB.id]);
    assert.equal(filteredReview.sources[0]?.targets[0]?.rows[0]?.disposition, "merge");
  });
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

test("context-unbound legacy drafts require re-extraction before application", async () => {
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
    assert.equal(hashless?.source.extractionFingerprint, undefined);

    for (const autoApplyLowRiskOnly of [true, false]) {
      await assert.rejects(
        applyLongTermMemoryDraft(draft.id, {
          root,
          autoApplyLowRiskOnly,
          rebuildIndexes: false,
        }),
        (error: unknown) =>
          error instanceof LtmDraftApplyError &&
          error.statusCode === 409 &&
          error.code === "ltm_draft_source_context_unbound",
      );
    }
    assert.equal(await storage.getNote("char_damo"), null);

    const reextracted = await store.createDraft({
      source: { sourceNoteId: source.id },
      scope: {},
      modes: ["roleplay"],
      response: responseFor(createCharacterMutation(source.id, "Damo keeps careful watch.")),
    });
    const applied = await applyLongTermMemoryDraft(reextracted.id, { root, rebuildIndexes: false });
    assert.equal(applied.draft.status, "accepted");
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
