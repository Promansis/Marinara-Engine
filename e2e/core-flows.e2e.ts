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

  await extractionPromptPanel.getByRole("button", { name: "Add option" }).click();
  await expect(extractionPromptPanel.getByPlaceholder("Option name")).toHaveValue("New template");
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
        response: {},
        appliedMutationIds: [],
        skippedMutationIds: [],
      }),
    });
  });
  await page.route("**/api/long-term-memory/drafts/pending-count", async (route) => {
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

  await page.getByRole("button", { name: "Active Context" }).click();
  await page.getByRole("button", { name: "Import →" }).click();

  const vaultDialog = page.getByRole("dialog", { name: "Long-Term Memory" });
  await expect(vaultDialog).toBeVisible();
  await vaultDialog.getByRole("button", { name: "Memories" }).click();
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
  await expect(page.getByText("No memory stream suggestions need review for this source.")).toBeVisible();
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

  await page.route("**/api/long-term-memory/drafts/pending-count", async (route) => {
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
  await page.keyboard.press("Escape");
  await expect(vaultDialog).toBeHidden();

  await moreOptions.click();
  await page.getByRole("button", { name: "Active Context" }).click();
  await page.getByRole("button", { name: "1 suggestion to review" }).click();

  await expect(page.getByRole("dialog", { name: "Review Memory Suggestions" })).toBeVisible();
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
