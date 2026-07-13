import { expect, test, type Page } from "@playwright/test";

function collectUnexpectedErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/favicon|ResizeObserver/i.test(text)) return;
    errors.push(text);
  });
  return errors;
}

async function prepareFreshClient(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "marinara-engine-ui",
      JSON.stringify({
        state: {
          hasCompletedOnboarding: true,
          rightPanelOpen: false,
          sidebarOpen: false,
        },
        version: 65,
      }),
    );
  });
}

const ltmNow = "2026-07-07T00:00:00.000Z";

function ltmNote(overrides: Partial<Record<string, unknown>> = {}) {
  const id = (overrides.id as string | undefined) ?? "scene_shared_ui_selection";
  const type = (overrides.type as string | undefined) ?? "scene";
  return {
    id,
    title: (overrides.title as string | undefined) ?? "Shared UI Selection Memory",
    type,
    status: (overrides.status as string | undefined) ?? "active",
    modes: (overrides.modes as string[] | undefined) ?? ["conversation"],
    scope: (overrides.scope as Record<string, unknown> | undefined) ?? {},
    tags: (overrides.tags as string[] | undefined) ?? ["shared_ui"],
    keywords: [],
    links: (overrides.links as Array<Record<string, unknown>> | undefined) ?? [],
    sections: (overrides.sections as Record<string, unknown> | undefined) ?? {
      summary: {
        text: "The shared UI convergence memory should be selectable.",
        updatedAt: ltmNow,
        evidence: ["e2e:shared-ui"],
      },
    },
    createdAt: ltmNow,
    updatedAt: ltmNow,
    version: 1,
    ...overrides,
  };
}

function ltmDraft(sourceNoteId: string) {
  const mutation = {
    id: "22222222-2222-4222-8222-222222222222",
    kind: "create_note",
    risk: "low",
    confidence: 0.92,
    summary: "Create a scene memory from the selected source.",
    evidence: ["e2e:shared-ui"],
    note: {
      id: "scene_shared_ui_suggestion",
      title: "Shared UI Suggestion",
      type: "scene",
      status: "active",
      modes: ["conversation"],
      scope: {},
      tags: ["shared_ui"],
      keywords: [],
      links: [{ target: sourceNoteId, relation: "extracted_from" }],
      sections: {
        summary: {
          text: "The suggestion row should use the shared selection action bar.",
          updatedAt: ltmNow,
          evidence: ["e2e:shared-ui"],
        },
      },
      version: 1,
    },
  };
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "pending",
    createdAt: ltmNow,
    updatedAt: ltmNow,
    operationId: "33333333-3333-4333-8333-333333333333",
    source: { sourceNoteId },
    scope: {},
    modes: ["conversation"],
    summary: "One pending suggestion for shared UI selection.",
    mutations: [mutation],
    diagnostics: [
      {
        severity: "warning",
        code: "mutation_needs_review",
        mutationId: mutation.id,
        message: "Confirm the shared UI suggestion before applying it.",
      },
      {
        severity: "error",
        code: "composite_character_subject",
        candidateIndex: 1,
        message: "Roselia and Damo were returned as one character subject.",
      },
      {
        severity: "warning",
        code: "deduplicated_evidence_unit",
        candidateIndex: 2,
        message: "A repeated candidate was deduplicated.",
      },
    ],
    extractionOutcome: {
      state: "partial_success",
      totalCandidates: 3,
      keptUnits: 1,
      droppedUnits: 2,
      droppedCandidates: [
        {
          index: 1,
          reason: "invalid_subject_cardinality",
          message: "Roselia and Damo were returned as one character subject.",
          snippet: "Roselia and Damo protected the archive together.",
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
  };
}

function ltmDraftReview(sourceNoteId: string, draft: ReturnType<typeof ltmDraft>) {
  const mutation = draft.mutations[0]!;
  return {
    generatedAt: ltmNow,
    sources: [
      {
        sourceNoteId,
        modes: ["conversation"],
        drafts: [
          {
            draft,
            freshness: "hashless",
            blockReasons: [],
            diagnostics: [draft.diagnostics[1]],
            candidateRejections: draft.extractionOutcome.droppedCandidates,
            deduplications: [draft.diagnostics[2]],
          },
        ],
        targets: [
          {
            noteId: mutation.note.id,
            title: mutation.note.title,
            noteType: mutation.note.type,
            rows: [
              {
                draftId: draft.id,
                mutation,
                disposition: "merge",
                diagnostics: [draft.diagnostics[0]],
                changes: [
                  {
                    kind: "section",
                    key: "summary",
                    before: "An earlier shared UI memory.",
                    after: mutation.note.sections.summary.text,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    counts: {
      sources: 1,
      drafts: 1,
      mutations: 1,
      blockedDrafts: 0,
      candidateRejections: 1,
      deduplications: 1,
    },
  };
}

async function openLtmVaultFromAgentEditor(page: Page) {
  await page.locator('[data-tour="panel-agents"]').click();
  await page.getByRole("button", { name: /Long-Term Memory/ }).click();
  await expect(page.locator(".mari-editor-title-input")).toHaveValue("Long-Term Memory");
  await page.getByRole("button", { name: "Manage Memories" }).click();
  const vaultDialog = page.getByRole("dialog", { name: "Long-Term Memory" });
  await expect(vaultDialog).toBeVisible();
  return vaultDialog;
}

async function createActiveConversation(page: Page, name: string) {
  const response = await page.request.post("/api/chats", {
    data: {
      name,
      mode: "conversation",
      characterIds: [],
    },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as { id: string };
  await page.addInitScript((chatId) => {
    localStorage.setItem("marinara-active-chat-id", chatId);
  }, chat.id);
  return chat;
}

test.beforeEach(async ({ page }) => {
  await prepareFreshClient(page);
});

test("home shell and primary topbar panels open without client errors", async ({ page }) => {
  const errors = collectUnexpectedErrors(page);
  await page.goto("/");

  await expect(page.locator('[data-component="TopBar"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Marinara Engine" })).toBeVisible();

  for (const selector of [
    '[data-tour="sidebar-toggle"]',
    '[data-tour="panel-bot-browser"]',
    '[data-tour="panel-characters"]',
    '[data-tour="panel-lorebooks"]',
    '[data-tour="panel-presets"]',
    '[data-tour="panel-connections"]',
    '[data-tour="panel-agents"]',
    '[data-tour="panel-personas"]',
    '[data-tour="panel-settings"]',
  ]) {
    await page.locator(selector).click();
    await expect(page.locator('[data-component="TopBar"]')).toBeVisible();
  }

  const health = await page.request.get("/api/health");
  expect(health.ok()).toBeTruthy();
  expect(errors).toEqual([]);
});

test("chat mode tabs and new-chat actions stay reachable", async ({ page }) => {
  const errors = collectUnexpectedErrors(page);
  await page.goto("/");

  await page.locator('[data-tour="sidebar-toggle"]').click();
  await expect(page.locator('[data-component="ChatSidebar"]')).toBeVisible();

  const modes = [
    { tour: "chat-mode-conversation", label: "New Conversation" },
    { tour: "chat-mode-roleplay", label: "New Roleplay" },
    { tour: "chat-mode-game", label: "New Game" },
  ];

  for (const mode of modes) {
    await page.locator(`[data-tour="${mode.tour}"]`).click();
    await expect(page.getByLabel(mode.label)).toBeVisible();
  }

  expect(errors).toEqual([]);
});

test("LTM extraction prompt options work without crypto.randomUUID", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "LTM prompt option UUID fallback is covered on desktop.");

  const nativeDialogs: string[] = [];
  page.on("dialog", (dialog) => {
    nativeDialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await page.addInitScript(() => {
    const webCrypto = globalThis.crypto as (Crypto & { randomUUID?: unknown }) | undefined;
    if (!webCrypto) return;
    try {
      Object.defineProperty(webCrypto, "randomUUID", { configurable: true, value: undefined });
    } catch {
      delete webCrypto.randomUUID;
    }
  });

  const errors = collectUnexpectedErrors(page);
  await page.goto("/");

  await page.locator('[data-tour="panel-agents"]').click();
  await page.getByRole("button", { name: /Long-Term Memory/ }).click();

  await expect(page.locator(".mari-editor-title-input")).toHaveValue("Long-Term Memory");
  const extractionPromptPanel = page
    .locator(".mari-editor-panel")
    .filter({ has: page.getByRole("heading", { name: "Extraction Prompt" }) });
  await expect(extractionPromptPanel).toBeVisible();

  const promptOptionSelect = extractionPromptPanel.getByLabel("Prompt option");
  await expect(promptOptionSelect).toContainText("Default Conversation prompt");

  await extractionPromptPanel.getByRole("button", { name: "Add" }).click();
  await expect(promptOptionSelect.locator("option:checked")).toHaveText("Conversation prompt");

  await extractionPromptPanel.getByRole("button", { name: "Rename" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename Prompt" });
  await expect(renameDialog).toBeVisible();
  const promptNameInput = renameDialog.getByPlaceholder("Prompt name");
  await expect(promptNameInput).toHaveValue("Conversation prompt");
  await promptNameInput.fill("Smoke prompt");
  await renameDialog.getByRole("button", { name: "Rename" }).click();
  await expect(promptOptionSelect).toContainText("Smoke prompt");

  const recallBudgetLabel = page.getByText("Recall context budget", { exact: true });
  const recallBudgetHelp = recallBudgetLabel.locator("..").getByRole("button", { name: "Show help" });
  await recallBudgetHelp.click();
  await expect(recallBudgetHelp).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("How many tokens recalled memories can use in the next prompt.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(recallBudgetHelp).toHaveAttribute("aria-expanded", "false");

  const promptTextarea = extractionPromptPanel.getByPlaceholder("Write the extraction system prompt...");
  await promptTextarea.fill(`${await promptTextarea.inputValue()}\nUnsaved smoke edit`);
  await extractionPromptPanel.getByRole("button", { name: "Roleplay", exact: true }).click();

  const discardDialog = page.getByRole("dialog", { name: "Discard prompt edits?" });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(extractionPromptPanel.getByRole("button", { name: "Conversation", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await extractionPromptPanel.getByRole("button", { name: "Roleplay", exact: true }).click();
  await page.getByRole("dialog", { name: "Discard prompt edits?" }).getByRole("button", { name: "Discard" }).click();
  await expect(extractionPromptPanel.getByRole("button", { name: "Roleplay", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(nativeDialogs).toEqual([]);
  expect(errors).toEqual([]);
});

test("memory recall modal accepts clicks from chat settings", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "Memory recall modal regression is covered on desktop.");

  const response = await page.request.post("/api/chats", {
    data: {
      name: "Memory Recall Menu Smoke",
      mode: "conversation",
      characterIds: [],
    },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as { id: string };

  await page.addInitScript((chatId) => {
    localStorage.setItem("marinara-active-chat-id", chatId);
  }, chat.id);
  await page.goto("/");

  await page.getByRole("button", { name: "Chat Settings" }).click();
  const drawer = page.locator(".mari-chat-settings-drawer");
  await expect(drawer.getByRole("heading", { name: "Chat Settings" })).toBeVisible();
  await drawer.getByText("Memory Recall", { exact: true }).click();
  await drawer.getByRole("button", { name: "Access memories for this chat" }).click();

  const dialog = page.getByRole("dialog", { name: "Memories for This Chat" });
  await expect(dialog).toBeVisible();
  await dialog.getByText("0 memory chunks").click();
  await expect(dialog).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Chat Settings" })).toBeVisible();
});

test("LTM notes selection uses shared action bar and opens delete confirmation", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "LTM shared action bar notes coverage runs on desktop.");

  const notes = [ltmNote()];

  await page.route(/\/api\/long-term-memory\/notes(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(notes) });
  });
  await page.route("**/api/long-term-memory/settings", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });

  await createActiveConversation(page, "LTM Notes Selection Shared UI");
  await page.goto("/");
  const vaultDialog = await openLtmVaultFromAgentEditor(page);

  await vaultDialog.getByRole("button", { name: "Scene 1 memory" }).click();
  await vaultDialog.getByLabel("Select Shared UI Selection Memory").check();
  await expect(vaultDialog.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(vaultDialog.getByRole("button", { name: "Move", exact: true })).toBeVisible();
  await expect(vaultDialog.getByRole("button", { name: "Remove from chat" })).toBeDisabled();

  await vaultDialog.getByRole("button", { name: "Clear" }).click();
  await expect(vaultDialog.getByRole("button", { name: "Copy" })).toHaveCount(0);

  await vaultDialog.getByLabel("Select Shared UI Selection Memory").check();
  await vaultDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Permanently Delete" })).toBeVisible();
});

test("LTM recall uses the selected chat runtime settings and refreshable source freshness", async ({ page }) => {
  const response = await page.request.post("/api/chats", {
    data: {
      name: "Selected LTM Recall Smoke",
      mode: "conversation",
      characterIds: [],
      groupId: "ltm_selected_recall_group",
    },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as { id: string };

  const metadataResponse = await page.request.patch(`/api/chats/${chat.id}/metadata`, {
    data: {
      enableLongTermMemory: true,
      longTermMemoryRecallStyle: "exact",
      longTermMemoryBudgetTokens: 1536,
      longTermMemoryMaxChunks: 7,
      longTermMemoryScoreThreshold: 0.25,
      longTermMemoryRecallContextMessages: 3,
      longTermMemorySemanticWeight: 0.11,
      longTermMemoryLexicalWeight: 0.22,
      longTermMemoryGraphWeight: 0.33,
      longTermMemoryKeywordWeight: 0.44,
      longTermMemoryIncludeResolved: true,
    },
  });
  expect(metadataResponse.ok()).toBeTruthy();

  await page.route("**/api/long-term-memory/settings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        enableLongTermMemory: false,
        longTermMemoryBudgetTokens: 2048,
        longTermMemoryMaxChunks: 12,
        longTermMemoryScoreThreshold: 0,
        longTermMemoryRecallContextMessages: 4,
        longTermMemoryRecallStyle: "balanced",
        longTermMemorySemanticWeight: 0.6,
        longTermMemoryLexicalWeight: 0.3,
        longTermMemoryGraphWeight: 0.1,
        longTermMemoryKeywordWeight: 0.2,
        longTermMemoryIncludeResolved: false,
        longTermMemoryRecallPreamble: "Relevant long-term memories for this reply:",
        longTermMemoryDebug: false,
      }),
    });
  });

  await page.route(/\/api\/long-term-memory\/notes(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        ltmNote({
          scope: { chatId: chat.id, chatIds: [chat.id], groupId: "ltm_selected_recall_group" },
          modes: ["conversation"],
        }),
      ]),
    });
  });

  let recallPayload: Record<string, unknown> | null = null;
  await page.route("**/api/long-term-memory/search", async (route) => {
    recallPayload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        chunks: [],
        usedTokens: 0,
        maxTokens: 1536,
        embeddingsAvailable: false,
        warnings: [],
        debug: {
          weights: {
            semanticWeight: 0.11,
            lexicalWeight: 0.22,
            graphWeight: 0.33,
            keywordWeight: 0.44,
          },
        },
      }),
    });
  });

  let importPreviewRequests = 0;
  await page.route("**/api/long-term-memory/import/preview", async (route) => {
    importPreviewRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source: "chats",
        scanned: 2,
        draftable: 1,
        importedCount: 1,
        samples: [
          {
            sourceId: "chat:changed",
            title: "Changed session summary",
            mutationCount: 1,
            summary: "The source changed after its first import.",
            snippet: "Changed source text",
            status: "pending",
            freshness: "stale",
            existingNoteId: "source_changed_session",
            existingNoteTitle: "Previous session summary",
          },
          {
            sourceId: "chat:current",
            title: "Current session summary",
            mutationCount: 1,
            summary: "The source is current.",
            snippet: "Current source text",
            status: "imported",
            freshness: "current",
            existingNoteId: "source_current_session",
            existingNoteTitle: "Current session summary",
          },
        ],
      }),
    });
  });

  await page.addInitScript((chatId) => {
    localStorage.setItem("marinara-active-chat-id", chatId);
  }, chat.id);
  await page.goto("/");

  const vaultDialog = await openLtmVaultFromAgentEditor(page);
  await vaultDialog.getByRole("button", { name: "Scene 1 memory" }).click();
  await vaultDialog.getByRole("button", { name: "Open Shared UI Selection Memory" }).click();

  const noteDialog = page.getByRole("dialog", { name: "Shared UI Selection Memory" });
  const overviewTab = noteDialog.getByRole("tab", { name: "Overview" });
  const contentsTab = noteDialog.getByRole("tab", { name: "Content" });
  await expect(overviewTab).toHaveAttribute("aria-selected", "true");
  await overviewTab.press("ArrowRight");
  await expect(contentsTab).toHaveAttribute("aria-selected", "true");
  await expect(contentsTab).toBeFocused();
  await noteDialog.getByRole("tab", { name: "Recall", exact: true }).click();
  const recallInput = noteDialog.getByLabel("Test recall query for Selected LTM Recall Smoke");
  await expect(recallInput).toBeVisible();
  await expect(recallInput).toHaveAccessibleName("Test recall query for Selected LTM Recall Smoke");
  await expect(noteDialog.getByRole("button", { name: "Test Recall" })).toBeVisible();

  await recallInput.fill("Where is the archive key?");
  await recallInput.press("Enter");
  await expect.poll(() => recallPayload).not.toBeNull();
  expect(recallPayload).toMatchObject({
    mode: "conversation",
    scope: { chatId: chat.id, chatIds: [chat.id], groupId: "ltm_selected_recall_group" },
    characterIds: [],
    includeResolved: true,
    maxChunks: 7,
    maxTokens: 1536,
    minScore: 0.25,
    semanticWeight: 0.11,
    lexicalWeight: 0.22,
    graphWeight: 0.33,
    keywordWeight: 0.44,
  });

  await noteDialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(noteDialog).toBeHidden();
  await vaultDialog.getByRole("tab", { name: "Import" }).click();
  await expect(vaultDialog.getByText("Source changed", { exact: true })).toBeVisible();
  await vaultDialog.getByRole("button", { name: /Imported source/ }).click();
  await expect(vaultDialog.getByText("Current", { exact: true })).toBeVisible();
  const refreshButton = vaultDialog.getByRole("button", { name: "Refresh available imports" });
  await expect(refreshButton).toBeVisible();
  await refreshButton.click();
  await expect.poll(() => importPreviewRequests).toBeGreaterThanOrEqual(2);
});

test("LTM chat overrides flush when Chat Settings closes", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "LTM debounce persistence is covered on desktop.");

  const response = await page.request.post("/api/chats", {
    data: {
      name: "LTM Override Flush Smoke",
      mode: "conversation",
      characterIds: [],
    },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as { id: string };

  const metadataResponse = await page.request.patch(`/api/chats/${chat.id}/metadata`, {
    data: { enableLongTermMemory: true },
  });
  expect(metadataResponse.ok()).toBeTruthy();

  await page.addInitScript((chatId) => {
    localStorage.setItem("marinara-active-chat-id", chatId);
  }, chat.id);
  await page.goto("/");

  await page.getByRole("button", { name: "Chat Settings" }).click();
  const drawer = page.locator(".mari-chat-settings-drawer");
  await drawer.getByRole("button", { name: /^Agents/ }).click();
  const budgetInput = drawer.getByRole("spinbutton", { name: "Recall context budget" });
  const chunksInput = drawer.getByRole("spinbutton", { name: "Max memories injected" });
  await budgetInput.fill("1536");
  await chunksInput.fill("7");
  await drawer.getByRole("button", { name: "Close chat settings" }).click();

  await expect
    .poll(async () => {
      const current = await page.request.get(`/api/chats/${chat.id}`);
      if (!current.ok()) return null;
      const body = (await current.json()) as {
        metadata?: string | { longTermMemoryBudgetTokens?: number; longTermMemoryMaxChunks?: number };
      };
      const metadata =
        typeof body.metadata === "string"
          ? (JSON.parse(body.metadata) as { longTermMemoryBudgetTokens?: number; longTermMemoryMaxChunks?: number })
          : body.metadata;
      return [metadata?.longTermMemoryBudgetTokens, metadata?.longTermMemoryMaxChunks];
    })
    .toEqual([1536, 7]);

  await page.reload();
  await page.getByRole("button", { name: "Chat Settings" }).click();
  await drawer.getByRole("button", { name: /^Agents/ }).click();
  await expect(drawer.getByRole("spinbutton", { name: "Recall context budget" })).toHaveValue("1536");
  await expect(drawer.getByRole("spinbutton", { name: "Max memories injected" })).toHaveValue("7");
});

test("LTM import selection shows shared action bar and keeps imported rows disabled", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "LTM shared action bar import coverage runs on desktop.");

  await page.route("**/api/long-term-memory/import/preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source: "chats",
        scanned: 2,
        draftable: 1,
        importedCount: 1,
        samples: [
          {
            sourceId: "chat_pending_shared_ui",
            title: "Pending shared UI source",
            mutationCount: 1,
            summary: "Pending source summary",
            snippet: "Pending source snippet",
            status: "pending",
          },
          {
            sourceId: "chat_imported_shared_ui",
            title: "Imported shared UI source",
            mutationCount: 0,
            summary: "Imported source summary",
            snippet: "Imported source snippet",
            status: "imported",
            existingNoteId: "source_imported_shared_ui",
            existingNoteTitle: "Existing imported memory",
          },
        ],
      }),
    });
  });
  await page.route(/\/api\/long-term-memory\/notes(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });

  await createActiveConversation(page, "LTM Import Selection Shared UI");
  await page.goto("/");
  const vaultDialog = await openLtmVaultFromAgentEditor(page);
  await vaultDialog.getByRole("tab", { name: "Import" }).click();

  await vaultDialog.getByLabel("Select Pending shared UI source").check();
  await expect(vaultDialog.getByRole("button", { name: "Import selected" })).toBeVisible();
  await expect(vaultDialog.getByRole("button", { name: "Clear" })).toBeVisible();

  await vaultDialog.getByRole("button", { name: /Imported source/ }).click();
  await expect(vaultDialog.getByLabel("Select Imported shared UI source")).toBeDisabled();
});

test("LTM partial import keeps failed sources selected and exposes recovery details", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "LTM partial import recovery is covered on desktop.");

  const successfulSource = ltmNote({
    id: "source_partial_success",
    title: "Successful source",
    type: "source",
    tags: ["source_summary", "imported_chat"],
    extracted: true,
  });
  const retrySource = ltmNote({
    id: "source_partial_retry",
    title: "Retry source",
    type: "source",
    tags: ["source_summary", "imported_chat"],
    extracted: false,
  });

  await page.route("**/api/long-term-memory/import/preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source: "chats",
        scanned: 2,
        draftable: 2,
        importedCount: 0,
        samples: [
          {
            sourceId: "chat_success:summary",
            title: "Successful source",
            mutationCount: 1,
            summary: "Import successful source",
            snippet: "A source that extracts successfully.",
            status: "pending",
          },
          {
            sourceId: "chat_retry:summary",
            title: "Retry source",
            mutationCount: 1,
            summary: "Import retry source",
            snippet: "A source whose extraction should be retried.",
            status: "pending",
          },
        ],
      }),
    });
  });
  await page.route("**/api/long-term-memory/import/source-notes", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        operationId: "33333333-3333-4333-8333-333333333333",
        batchStatus: "partial_success",
        source: "chats",
        imported: [
          {
            sourceId: "chat_success:summary",
            title: "Successful source",
            note: successfulSource,
            created: true,
            sourceWriteStatus: "created",
            extractionStatus: "succeeded",
            extractionMethod: "llm",
            retryable: false,
            draft: ltmDraft(successfulSource.id as string),
            diagnostics: [],
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
            appliedMutationIds: [],
            skippedMutationIds: [],
          },
          {
            sourceId: "chat_retry:summary",
            title: "Retry source",
            note: retrySource,
            created: true,
            sourceWriteStatus: "created",
            extractionStatus: "failed",
            extractionMethod: "llm",
            retryable: true,
            error: { code: "extract_failed", message: "Provider timed out" },
            draft: null,
            diagnostics: [{ severity: "error", code: "extract_failed", message: "Provider timed out" }],
            outcome: {
              state: "no_suggestions_created",
              totalCandidates: 0,
              keptUnits: 0,
              droppedUnits: 0,
              droppedCandidates: [],
            },
            accounting: {
              providerCandidates: 0,
              normalizedAdditions: 0,
              parserRejections: 0,
              validationRejections: 0,
              deduplications: 0,
              keptUnits: 0,
            },
            appliedMutationIds: [],
            skippedMutationIds: [],
          },
        ],
        writeFailures: [],
        missingSourceIds: [],
        counts: {
          requested: 2,
          sourceNotesWritten: 2,
          succeeded: 1,
          failed: 1,
          cancelled: 0,
          missing: 0,
          sourceWriteFailed: 0,
        },
      }),
    });
  });
  await page.route(/\/api\/long-term-memory\/notes(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });

  await createActiveConversation(page, "LTM Partial Import Recovery");
  await page.goto("/");
  const vaultDialog = await openLtmVaultFromAgentEditor(page);
  const importTab = vaultDialog.getByRole("tab", { name: "Import" });
  await importTab.click();
  await expect(importTab).toHaveAttribute("aria-selected", "true");
  await importTab.press("ArrowRight");
  await expect(vaultDialog.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true");
  await vaultDialog.getByRole("tab", { name: "Review" }).press("ArrowLeft");

  await vaultDialog.getByLabel("Select Successful source").check();
  await vaultDialog.getByLabel("Select Retry source").check();
  await vaultDialog.getByRole("button", { name: "Import selected" }).click();

  await expect(vaultDialog.getByText("Import partly complete")).toBeVisible();
  await expect(vaultDialog.getByText("Retry source:")).toBeVisible();
  await expect(vaultDialog.getByText("Provider timed out")).toBeVisible();
  await expect(vaultDialog.getByLabel("Select Successful source")).not.toBeChecked();
  await expect(vaultDialog.getByLabel("Select Retry source")).toBeChecked();
  await expect(vaultDialog.getByRole("button", { name: "Open Review" })).toBeVisible();
});

test("LTM in-flight import can be cancelled without clearing the retry selection", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "LTM import cancellation is covered on desktop.");

  await page.route("**/api/long-term-memory/import/preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source: "chats",
        scanned: 1,
        draftable: 1,
        importedCount: 0,
        samples: [
          {
            sourceId: "chat_cancel:summary",
            title: "Cancel retry source",
            mutationCount: 1,
            summary: "Import cancellable source",
            snippet: "A request that remains in flight until cancelled.",
            status: "pending",
          },
        ],
      }),
    });
  });

  let releaseImport: (() => void) | null = null;
  let markImportStarted: (() => void) | null = null;
  const importStarted = new Promise<void>((resolve) => {
    markImportStarted = resolve;
  });
  await page.route("**/api/long-term-memory/import/source-notes", async (route) => {
    markImportStarted?.();
    await new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    await route.abort("aborted").catch(() => undefined);
  });

  await createActiveConversation(page, "LTM Import Cancellation");
  await page.goto("/");
  const vaultDialog = await openLtmVaultFromAgentEditor(page);
  await vaultDialog.getByRole("tab", { name: "Import" }).click();
  await vaultDialog.getByLabel("Select Cancel retry source").check();
  await vaultDialog.getByRole("button", { name: "Import selected" }).click();
  await importStarted;

  await expect(vaultDialog.getByRole("button", { name: "Cancel import" })).toBeVisible();
  await vaultDialog.getByRole("button", { name: "Cancel import" }).click();
  releaseImport?.();

  await expect(page.getByText("Import cancelled. Unfinished sources remain selected.")).toBeVisible();
  await expect(vaultDialog.getByLabel("Select Cancel retry source")).toBeChecked();
});

test("LTM query failures render retry states instead of empty states", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "LTM query failure states are covered on desktop.");

  await page.route(/\/api\/long-term-memory\/notes(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Notes unavailable" }),
    });
  });
  await page.route(/\/api\/long-term-memory\/drafts(?:\/review)?(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Suggestions unavailable" }),
    });
  });
  await page.route("**/api/long-term-memory/import/preview", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });

  await createActiveConversation(page, "LTM Query Failure States");
  await page.goto("/");
  const vaultDialog = await openLtmVaultFromAgentEditor(page);

  await expect(vaultDialog.getByText("Memories could not load")).toBeVisible();
  await expect(vaultDialog.getByText("No matching memories.")).toHaveCount(0);

  await vaultDialog.getByRole("tab", { name: "Import" }).click();
  await expect(vaultDialog.getByText("Import sources could not load")).toBeVisible();
  await expect(vaultDialog.getByText("No sources are ready to bring in.")).toHaveCount(0);

  await vaultDialog.getByRole("tab", { name: "Review" }).click();
  await expect(vaultDialog.getByText("Suggestions could not load")).toBeVisible();
  await expect(vaultDialog.getByText("No pending suggestions to review.")).toHaveCount(0);
  await expect(vaultDialog.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("LTM repair requires confirmation and reports each action", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "LTM repair recovery is covered on desktop.");

  const status = {
    initialized: true,
    directory: "long-term-memory",
    notes: { total: 1, byType: { world: 1 }, byStatus: { active: 1 } },
    events: { logAvailable: false, bytes: 0 },
    indexes: {
      health: "stale",
      manifestAvailable: true,
      generationId: "44444444-4444-4444-8444-444444444444",
      currentGenerationId: "44444444-4444-4444-8444-444444444444",
      recovered: false,
      dirty: true,
      rebuildState: "idle",
      errors: [],
      warnings: [],
      generatedAt: ltmNow,
      sourceHash: "a".repeat(64),
      noteCount: 1,
      chunkCount: 2,
      chunkFormatVersion: 3,
      embeddingsAvailable: false,
      embeddedChunkCount: 0,
    },
  };
  const healthyIntegrity = {
    ok: true,
    health: "healthy",
    checkedAt: ltmNow,
    noteCount: 1,
    eventCount: 0,
    issues: [],
  };
  let repairCalls = 0;
  await page.route("**/api/long-term-memory/status", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status) });
  });
  await page.route("**/api/long-term-memory/integrity", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(healthyIntegrity) });
  });
  await page.route("**/api/long-term-memory/repair", async (route) => {
    repairCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        repairedAt: ltmNow,
        actions: [
          { action: "quarantine_malformed_notes", result: "quarantined", count: 1 },
          { action: "backfill_imported_source_titles", result: "backfilled", count: 2 },
          { action: "rebuild_indexes", result: "rebuilt", count: 4 },
        ],
        integrity: healthyIntegrity,
      }),
    });
  });

  await page.goto("/");
  await page.locator('[data-tour="panel-agents"]').click();
  await page.getByRole("button", { name: /Long-Term Memory/ }).click();
  await page.getByRole("button", { name: "Maintenance" }).click();
  await page.getByRole("button", { name: "Repair Memory Store" }).click();

  await expect(page.getByRole("dialog", { name: "Repair Memory Store?" })).toBeVisible();
  expect(repairCalls).toBe(0);
  await page.getByRole("dialog", { name: "Repair Memory Store?" }).getByRole("button", { name: "Repair" }).click();

  await expect(page.getByText("Latest repair")).toBeVisible();
  await expect(page.getByText("Malformed files")).toBeVisible();
  await expect(page.getByText("Imported-source titles")).toBeVisible();
  await expect(page.getByText("Memory index", { exact: true })).toBeVisible();
  expect(repairCalls).toBe(1);
});

test("LTM source suggestions select mode uses shared keep and skip bar", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "LTM suggestion selection coverage runs on desktop.");

  const sourceNote = ltmNote({
    id: "source_shared_ui_review",
    title: "Shared UI Review Source",
    type: "source",
    tags: ["imported_chat"],
    sections: {
      source: {
        text: "The source note has one suggestion to keep or skip.",
        updatedAt: ltmNow,
        evidence: ["e2e:shared-ui"],
      },
    },
  });
  const draft = ltmDraft(sourceNote.id as string);

  await page.route(/\/api\/long-term-memory\/notes(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([sourceNote]) });
  });
  await page.route(/\/api\/long-term-memory\/drafts(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([draft]) });
  });
  await page.route(/\/api\/long-term-memory\/drafts\/review(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ltmDraftReview(sourceNote.id as string, draft)),
    });
  });

  await createActiveConversation(page, "LTM Suggestions Selection Shared UI");
  await page.goto("/");
  const vaultDialog = await openLtmVaultFromAgentEditor(page);

  await vaultDialog.getByRole("tab", { name: "Review" }).click();
  await expect(vaultDialog.getByText("Shared UI Review Source")).toBeVisible();
  await expect(vaultDialog.getByText("1 Merge")).toBeVisible();
  await vaultDialog.getByRole("button", { name: "Review" }).click();
  const memoryDialog = page.getByRole("dialog", { name: "Shared UI Review Source" });
  await expect(memoryDialog).toBeVisible();
  await memoryDialog.getByRole("tab", { name: "Suggestions", exact: true }).click();
  await expect(memoryDialog.getByText("composite_character_subject")).toBeVisible();
  const targetDisclosure = memoryDialog.getByRole("button", { name: /Shared UI Suggestion/ });
  await targetDisclosure.focus();
  await expect(targetDisclosure).toHaveAttribute("aria-expanded", "false");
  await targetDisclosure.press("Enter");
  await expect(targetDisclosure).toHaveAttribute("aria-expanded", "true");
  await expect(memoryDialog.getByText("Confirm the shared UI suggestion before applying it.")).toBeVisible();
  await expect(memoryDialog.getByText("Merge", { exact: true })).toBeVisible();
  await memoryDialog.getByRole("button", { name: "View changes (1)" }).click();
  await expect(memoryDialog.getByText("Before: summary")).toBeVisible();
  await expect(memoryDialog.getByText("An earlier shared UI memory.")).toBeVisible();
  await memoryDialog.getByRole("button", { name: "Select", exact: true }).click();
  await memoryDialog.getByLabel("Select Scene: Shared Ui Suggestion").check();

  await expect(memoryDialog.getByRole("button", { name: "Keep selected" })).toBeVisible();
  await expect(memoryDialog.getByRole("button", { name: "Skip selected" })).toBeVisible();
  await memoryDialog.getByRole("button", { name: "Clear" }).last().click();
  await expect(memoryDialog.getByRole("button", { name: "Keep selected" })).toHaveCount(0);

  await page.reload();
  const reopenedVault = await openLtmVaultFromAgentEditor(page);
  await reopenedVault.getByRole("tab", { name: "Review" }).click();
  await reopenedVault.getByRole("button", { name: "Review" }).click();
  const reopenedMemory = page.getByRole("dialog", { name: "Shared UI Review Source" });
  await reopenedMemory.getByRole("tab", { name: "Suggestions", exact: true }).click();
  await expect(reopenedMemory.getByText("composite_character_subject")).toBeVisible();
});

test("LTM failed acceptance refreshes Review into a stale blocked state", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "LTM stale Review actions are covered on desktop.");

  const sourceNote = ltmNote({
    id: "source_stale_review_action",
    title: "Stale Review Source",
    type: "source",
    tags: ["imported_chat"],
    sections: {
      source: {
        text: "The source changes while its suggestion is open.",
        updatedAt: ltmNow,
        evidence: ["e2e:stale-review"],
      },
    },
  });
  const draft = ltmDraft(sourceNote.id as string);
  let stale = false;

  await page.route(/\/api\/long-term-memory\/notes(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([sourceNote]) });
  });
  await page.route(/\/api\/long-term-memory\/drafts(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([draft]) });
  });
  await page.route(/\/api\/long-term-memory\/drafts\/review(?:\?.*)?$/, async (route) => {
    const review = ltmDraftReview(sourceNote.id as string, draft);
    if (stale) {
      review.sources[0]!.drafts[0]!.freshness = "stale";
      review.sources[0]!.drafts[0]!.blockReasons = [
        { code: "source_stale", message: "The source changed after this extraction." },
      ];
      review.counts.blockedDrafts = 1;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(review) });
  });
  await page.route(`**/api/long-term-memory/drafts/${draft.id}/accept`, async (route) => {
    stale = true;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "The source changed after this extraction.", code: "ltm_draft_source_stale" }),
    });
  });

  await createActiveConversation(page, "LTM Stale Review Action");
  await page.goto("/");
  const vaultDialog = await openLtmVaultFromAgentEditor(page);
  await vaultDialog.getByRole("tab", { name: "Review" }).click();
  await vaultDialog.getByRole("button", { name: "Review" }).click();
  const memoryDialog = page.getByRole("dialog", { name: "Stale Review Source" });
  await memoryDialog.getByRole("tab", { name: "Suggestions", exact: true }).click();
  await memoryDialog.getByRole("button", { name: /Shared UI Suggestion/ }).click();
  await memoryDialog.getByRole("button", { name: "Keep", exact: true }).click();

  await expect(memoryDialog.getByText("source_stale")).toBeVisible();
  await expect(memoryDialog.getByRole("button", { name: "Keep", exact: true })).toBeDisabled();
});

test("LTM diagnostic-only drafts remain reviewable and can be dismissed", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "LTM diagnostic-only Review is covered on desktop.");

  const sourceNote = ltmNote({
    id: "source_diagnostic_only_review",
    title: "Diagnostic Only Source",
    type: "source",
    tags: ["imported_chat"],
    sections: {
      source: {
        text: "The provider returned one malformed candidate.",
        updatedAt: ltmNow,
        evidence: ["e2e:diagnostic-only"],
      },
    },
  });
  const draft = {
    ...ltmDraft(sourceNote.id as string),
    summary: "No mutation survived extraction.",
    mutations: [],
    diagnostics: [
      {
        severity: "error",
        code: "candidate_parse_failed",
        candidateIndex: 0,
        message: "The provider candidate was malformed.",
      },
    ],
    extractionOutcome: {
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
  };
  let dismissed = false;

  await page.route(/\/api\/long-term-memory\/notes(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([sourceNote]) });
  });
  await page.route(/\/api\/long-term-memory\/drafts(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(dismissed ? [] : [draft]),
    });
  });
  await page.route(/\/api\/long-term-memory\/drafts\/review(?:\?.*)?$/, async (route) => {
    const response = dismissed
      ? {
          generatedAt: ltmNow,
          sources: [],
          counts: {
            sources: 0,
            drafts: 0,
            mutations: 0,
            blockedDrafts: 0,
            candidateRejections: 0,
            deduplications: 0,
          },
        }
      : {
          generatedAt: ltmNow,
          sources: [
            {
              sourceNoteId: sourceNote.id,
              modes: ["conversation"],
              drafts: [
                {
                  draft,
                  freshness: "hashless",
                  blockReasons: [{ code: "no_mutations", message: "No mutation survived extraction." }],
                  diagnostics: draft.diagnostics,
                  candidateRejections: draft.extractionOutcome.droppedCandidates,
                  deduplications: [],
                },
              ],
              targets: [],
            },
          ],
          counts: {
            sources: 1,
            drafts: 1,
            mutations: 0,
            blockedDrafts: 1,
            candidateRejections: 1,
            deduplications: 0,
          },
        };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.route(`**/api/long-term-memory/drafts/${draft.id}`, async (route) => {
    dismissed = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ deleted: true, id: draft.id }),
    });
  });

  await createActiveConversation(page, "LTM Diagnostic Only Review");
  await page.goto("/");
  const vaultDialog = await openLtmVaultFromAgentEditor(page);
  await vaultDialog.getByRole("tab", { name: "Review" }).click();
  await expect(vaultDialog.getByText("Diagnostics only")).toBeVisible();
  await vaultDialog.getByRole("button", { name: "Review" }).click();
  const memoryDialog = page.getByRole("dialog", { name: "Diagnostic Only Source" });
  await memoryDialog.getByRole("tab", { name: "Suggestions", exact: true }).click();
  await expect(memoryDialog.getByText("candidate_parse_failed")).toBeVisible();
  await memoryDialog.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Dismiss extraction report?" })
    .getByRole("button", { name: "Dismiss" })
    .click();

  await expect(memoryDialog.getByText("candidate_parse_failed")).toHaveCount(0);
  await expect(memoryDialog.getByText("No memory suggestions need review for this source note.")).toBeVisible();
});

test("manual memory recovery survives dismissing the create modal", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "LTM recovery regression is covered on desktop.");

  const response = await page.request.post("/api/chats", {
    data: {
      name: "LTM Recovery Persistence",
      mode: "conversation",
      characterIds: [],
    },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as { id: string };

  const sourceNoteId = `source_review_reopen_${Date.now()}`;
  const sourceTitle = "Dropped Candidate Source";
  const createSourceNote = await page.request.post("/api/long-term-memory/notes", {
    data: {
      id: sourceNoteId,
      title: sourceTitle,
      type: "source",
      status: "active",
      modes: ["conversation"],
      scope: { chatIds: [chat.id] },
      tags: ["imported_chat"],
      links: [],
      sections: {
        source: {
          text: "A short imported source summary for review testing.",
          updatedAt: new Date().toISOString(),
          evidence: ["chat_name:LTM Recovery Persistence", "message_range:1-3"],
        },
      },
      version: 1,
    },
  });
  expect(createSourceNote.ok()).toBeTruthy();

  await page.route(`**/api/long-term-memory/notes/${sourceNoteId}/extract`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        operationId: "66666666-6666-4666-8666-666666666666",
        draft: null,
        diagnostics: [],
        outcome: {
          state: "no_suggestions_created",
          totalCandidates: 1,
          keptUnits: 0,
          droppedUnits: 1,
          droppedCandidates: [
            {
              index: 0,
              reason: "unsupported_bucket",
              message: "Needs a manual memory instead of an automatic suggestion.",
              snippet: "Captain Vale promised to return at dawn with the key.",
              recovery: {
                noteType: "scene",
                noteId: "scene_captain_vale_returns",
                sectionKey: "summary",
                status: "active",
              },
            },
          ],
        },
        accounting: {
          providerCandidates: 1,
          normalizedAdditions: 0,
          parserRejections: 0,
          validationRejections: 1,
          deduplications: 0,
          keptUnits: 0,
        },
        response: { summary: "", mutations: [] },
        appliedMutationIds: [],
        skippedMutationIds: [],
      }),
    });
  });
  await page.route(/\/api\/long-term-memory\/drafts\/pending-count(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 1 }),
    });
  });

  await page.addInitScript((chatId) => {
    localStorage.setItem("marinara-active-chat-id", chatId);
  }, chat.id);
  await page.goto("/");

  const vaultDialog = await openLtmVaultFromAgentEditor(page);
  await vaultDialog.getByRole("tab", { name: "Memories" }).click();
  await vaultDialog.getByRole("button", { name: /^Source/ }).click();
  await vaultDialog.getByRole("button", { name: `Open ${sourceTitle}` }).click();

  await page.getByRole("button", { name: "Re-run extraction" }).click();
  await page.getByRole("dialog", { name: "Re-run extraction?" }).getByRole("button", { name: "Re-run" }).click();
  await expect(page.getByRole("button", { name: "Create manual memory" })).toBeVisible();

  await page.getByRole("button", { name: "Create manual memory" }).click();
  const createMemoryDialog = page.getByRole("dialog", { name: "New Memory" });
  await expect(createMemoryDialog).toBeVisible();
  await createMemoryDialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("dialog", { name: "Discard Draft" }).getByRole("button", { name: "Discard" }).click();
  await expect(createMemoryDialog).toBeHidden();

  await vaultDialog.getByRole("button", { name: `Open ${sourceTitle}` }).click();
  await expect(page.getByRole("button", { name: "Create manual memory" })).toBeVisible();

  await page.getByRole("button", { name: "Remove all" }).click();
  await expect(page.getByRole("button", { name: "Create manual memory" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove all" })).toHaveCount(0);
  await expect(page.getByText("No usable suggestions were created from the latest extraction.")).toBeVisible();
  await expect(page.getByText("No memory suggestions need review for this source note.")).toBeVisible();
});

test("mobile LTM overflow actions open modals and advertise pending review", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Mobile LTM overflow regression is covered on mobile.");

  const response = await page.request.post("/api/chats", {
    data: {
      name: "Mobile LTM Overflow Smoke",
      mode: "conversation",
      characterIds: [],
    },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as { id: string };

  await page.addInitScript((chatId) => {
    localStorage.setItem("marinara-active-chat-id", chatId);
  }, chat.id);

  await page.route(/\/api\/long-term-memory\/drafts\/pending-count(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 1 }),
    });
  });
  await page.route(/\/api\/long-term-memory\/drafts(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.goto("/");

  const moreOptions = page.getByRole("button", { name: "More options" });
  await expect(moreOptions).toHaveClass(/animate-pulse-ring/);

  await moreOptions.click();
  await page.getByRole("button", { name: "Active Context" }).click();
  await page.getByRole("button", { name: "Import →" }).click();

  const vaultDialog = page.getByRole("dialog", { name: "Long-Term Memory" });
  await expect(vaultDialog).toBeVisible();
  await expect(vaultDialog.getByRole("tab", { name: "Import" })).toHaveAttribute("aria-selected", "true");
  await expect(vaultDialog.getByLabel("Source")).toBeVisible();

  const memoriesTab = vaultDialog.getByRole("tab", { name: "Memories" });
  await expect(memoriesTab).toHaveText("Memories");
  expect(
    await memoriesTab.evaluate((element) => ({
      horizontallyClipped: element.scrollWidth > element.clientWidth,
      verticallyClipped: element.scrollHeight > element.clientHeight,
    })),
  ).toEqual({ horizontallyClipped: false, verticallyClipped: false });

  await memoriesTab.click();
  await expect(vaultDialog.getByRole("textbox", { name: "Search memories" })).toBeVisible();
  await expect(vaultDialog.getByRole("combobox", { name: "Memory type" })).toBeVisible();
  await expect(vaultDialog.getByRole("combobox", { name: "Memory status" })).toBeVisible();
  await expect(vaultDialog.getByRole("combobox", { name: "Memory mode" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(vaultDialog).toBeHidden();

  await moreOptions.click();
  await page.getByRole("button", { name: "Active Context" }).click();
  await page.getByRole("button", { name: "1 suggestion to review" }).click();

  await expect(vaultDialog).toBeVisible();
  await expect(vaultDialog.getByText("No pending suggestions to review.")).toBeVisible();
});

test("mobile topbar remains reachable while sidebars switch", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Mobile shell smoke only runs in the mobile project.");

  const errors = collectUnexpectedErrors(page);
  await page.goto("/");

  await page.locator('[data-tour="sidebar-toggle"]').click();
  await expect(page.locator('[data-component="TopBar"]')).toBeVisible();
  await expect(page.locator('[data-component="ChatSidebar"]')).toBeVisible();

  await page.locator('[data-tour="panel-characters"]').click();
  await expect(page.locator('[data-component="TopBar"]')).toBeVisible();
  await expect(page.locator('[data-component="RightPanelMobile"]')).toBeVisible();

  await page.locator('[data-tour="panel-settings"]').click();
  await expect(page.locator('[data-component="TopBar"]')).toBeVisible();
  await expect(page.locator('[data-component="RightPanelMobile"]')).toBeVisible();

  expect(errors).toEqual([]);
});
