import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { clickTopbarPanel } from "./topbar-navigation.js";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const callsManifest = {
  schemaVersion: 1,
  id: "conversation-calls",
  name: "Calls",
  version: "1.0.17",
  description: "Speech to Text card fixture.",
  engine: { min: "2.4.1", maxExclusive: "4.0.0" },
  kind: ["agent", "conversation-calls"],
  entrypoints: { client: "client.js" },
  files: [],
  permissions: ["network", "ui"],
  restartRequired: true,
};

// #7344: an edit made just before leaving Connections is saved once, and Connections shows it when opened again.
// On a phone, switching to the chat list unmounts the card at once, so it must not come back with older settings.
test("Speech to Text keeps an edit made just before leaving Connections", async ({ page }, testInfo) => {
  // Own server is the saved choice, so its fields are showing when Connections opens.
  const saved = { enabled: true, baseUrl: "", apiKey: "", model: "", language: "" };
  const saves: Array<Record<string, unknown>> = [];
  let heldSave: Promise<void> | null = null;
  let failHeldSave = false;
  await page.route("**/api/app-settings/ui", (route) =>
    route.fulfill({ json: route.request().method() === "GET" ? { value: null } : { success: true } }),
  );
  await page.route("**/api/capability-packages/installed", (route) =>
    route.fulfill({
      json: [
        {
          id: callsManifest.id,
          version: callsManifest.version,
          manifest: callsManifest,
          installedAt: "2026-10-09T00:00:00Z",
          status: "active",
          error: null,
          readiness: "ready",
          readinessError: null,
          legacy: false,
        },
      ],
    }),
  );
  await page.route("**/api/capability-packages/conversation-calls/client*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'customElements.define("marinara-capability-conversation-calls", class extends HTMLElement {});',
    }),
  );
  await page.route("**/api/speech-to-text/config", async (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: saved });
    const body = route.request().postDataJSON() as typeof saved;
    saves.push(body);
    const waitForRelease = heldSave;
    const shouldFail = failHeldSave;
    heldSave = null;
    failHeldSave = false;
    if (waitForRelease) await waitForRelease;
    if (shouldFail) return route.fulfill({ status: 500, json: { error: "Save failed fixture" } });
    Object.assign(saved, body, { apiKey: body.apiKey ? "••••••" : "" });
    return route.fulfill({ status: 204 });
  });
  await seedUIState(page, { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false });
  await page.addInitScript((version) => localStorage.setItem("marinara:whats-new:seen-version", version), version);
  await page.goto("/");

  const card = page.locator('[data-component="SpeechToTextCard"]');
  const serverUrl = card.getByPlaceholder("http://localhost:8000/v1");
  const leaveConnections = async () => {
    const name = testInfo.project.name.startsWith("mobile") ? "Chats" : "Close panel";
    await page.getByRole("button", { name, exact: true }).filter({ visible: true }).click();
    await expect(serverUrl).toBeHidden();
  };
  const openCard = async () => {
    await clickTopbarPanel(page, "connections");
    await expect(serverUrl).toBeVisible();
  };

  await openCard();
  // Off / Browser / Own server is one radio group, and Own server is the one picked.
  const modes = card.getByRole("radiogroup", { name: "Speech to text" });
  await expect(modes.getByRole("radio")).toHaveText(["Off", "Browser", "Own server"]);
  await expect(modes.getByRole("radio", { name: "Own server" })).toBeChecked();
  // Own server only changes Calls; the chat microphone still dictates through the browser, and the card says so.
  await expect(card.getByText("Typing by voice in chat still uses your browser.", { exact: false })).toBeVisible();
  await expect(card.getByText("Calls use Local Whisper until you set a server address.")).toBeVisible();
  await expect(card.locator("div.bg-gradient-to-br").first()).toHaveClass(/from-sky-400 to-blue-500/);
  const ttsCard = page.locator('[data-component="TTSConfigCard"]');
  const expandTts = ttsCard.getByTitle("Expand", { exact: true });
  await expect(expandTts).toBeVisible();
  await expandTts.click();
  const surfaceStyle = (locator: typeof card) =>
    locator.evaluate((element) => {
      const icon = element.querySelector("svg.lucide-mic, svg.lucide-volume-2")!;
      const surface = getComputedStyle(element);
      const tile = getComputedStyle(icon.parentElement!);
      return {
        background: surface.backgroundImage,
        border: surface.borderColor,
        tile: tile.backgroundImage,
        icon: tile.color,
      };
    });
  const expectMatchingSurfaces = () =>
    expect
      .poll(
        async () => {
          const speechToText = await surfaceStyle(card);
          const textToSpeech = await surfaceStyle(ttsCard);
          return JSON.stringify(speechToText) === JSON.stringify(textToSpeech) ? null : { speechToText, textToSpeech };
        },
        { message: "Speech to Text uses the original Connections blue, matching Text to Speech" },
      )
      .toBeNull();
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (theme) => {
      const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
      const settings = useUIStore.getState();
      settings.setAppAccentColor("#22c55e");
      settings.setAppAccentRgbMode(false);
      settings.setAppAccentPulseMode(false);
      settings.setTheme(theme);
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expectMatchingSurfaces();
    await card.screenshot({
      path: testInfo.outputPath(`speech-to-text-connections-${theme}.png`),
      animations: "disabled",
    });
  }
  await serverUrl.fill("http://localhost:9000/v1");
  // Leave before the autosave delay runs out.
  await leaveConnections();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({ baseUrl: "http://localhost:9000/v1" });

  await openCard();
  await expect(serverUrl).toHaveValue("http://localhost:9000/v1");

  // Leaving again without another edit sends nothing new.
  await leaveConnections();
  await openCard();
  await expect(serverUrl).toHaveValue("http://localhost:9000/v1");
  await page.waitForTimeout(700);
  expect(saves).toHaveLength(1);

  // The debounce can fire while a slow phone is closing Connections. Keep that save in flight
  // through unmount; cleanup must wait for it, rather than send the same edit a second time.
  let releaseSave!: () => void;
  heldSave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await serverUrl.fill("http://localhost:9001/v1");
  try {
    await expect.poll(() => saves.length).toBe(2);
    await leaveConnections();
  } finally {
    releaseSave();
  }
  await expect.poll(() => saved.baseUrl).toBe("http://localhost:9001/v1");
  await openCard();
  await expect(serverUrl).toHaveValue("http://localhost:9001/v1");
  await page.waitForTimeout(700);
  expect(saves).toHaveLength(2);

  // On a phone the card unmounts. If its in-flight save fails, cleanup must still retry it.
  if (testInfo.project.name.startsWith("mobile")) {
    heldSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    failHeldSave = true;
    await serverUrl.fill("http://localhost:9002/v1");
    try {
      await expect.poll(() => saves.length).toBe(3);
      await leaveConnections();
    } finally {
      releaseSave();
    }
    await expect.poll(() => saved.baseUrl).toBe("http://localhost:9002/v1");
    expect(saves.slice(2).map((save) => save.baseUrl)).toEqual([
      "http://localhost:9002/v1",
      "http://localhost:9002/v1",
    ]);
    await openCard();
    await expect(serverUrl).toHaveValue("http://localhost:9002/v1");
    await page.waitForTimeout(700);
    expect(saves).toHaveLength(4);
  }

  // A newer edit must survive the older request completing; neither can land out of order.
  const beforeNewerEdit = saves.length;
  heldSave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await serverUrl.fill("http://localhost:9003/v1");
  try {
    await expect.poll(() => saves.length).toBe(beforeNewerEdit + 1);
    await serverUrl.fill("http://localhost:9004/v1");
    await leaveConnections();
  } finally {
    releaseSave();
  }
  await expect.poll(() => saved.baseUrl).toBe("http://localhost:9004/v1");
  expect(saves.slice(beforeNewerEdit).map((save) => save.baseUrl)).toEqual([
    "http://localhost:9003/v1",
    "http://localhost:9004/v1",
  ]);
  await openCard();
  await expect(serverUrl).toHaveValue("http://localhost:9004/v1");
  await page.waitForTimeout(700);
  expect(saves).toHaveLength(beforeNewerEdit + 2);
});

type SpeechToTextFixture = { calls: boolean; enabled: boolean; micEnabled: boolean };

async function openSpeechToTextCard(page: Page, fixture: SpeechToTextFixture) {
  const saved = { enabled: fixture.enabled, baseUrl: "", apiKey: "", model: "", language: "" };
  const saves: Array<Record<string, unknown>> = [];
  await page.route("**/api/app-settings/ui", (route) =>
    route.fulfill({ json: route.request().method() === "GET" ? { value: null } : { success: true } }),
  );
  await page.route("**/api/capability-packages/installed", (route) =>
    route.fulfill({
      json: fixture.calls
        ? [
            {
              id: callsManifest.id,
              version: callsManifest.version,
              manifest: callsManifest,
              installedAt: "2026-10-09T00:00:00Z",
              status: "active",
              error: null,
              readiness: "ready",
              readinessError: null,
              legacy: false,
            },
          ]
        : [],
    }),
  );
  await page.route("**/api/capability-packages/conversation-calls/client*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'customElements.define("marinara-capability-conversation-calls", class extends HTMLElement {});',
    }),
  );
  await page.route("**/api/speech-to-text/config", (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: saved });
    const body = route.request().postDataJSON() as typeof saved;
    saves.push(body);
    Object.assign(saved, body);
    return route.fulfill({ status: 204 });
  });
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    speechToTextEnabled: fixture.micEnabled,
  });
  await page.addInitScript((version) => localStorage.setItem("marinara:whats-new:seen-version", version), version);
  await page.goto("/");
  await clickTopbarPanel(page, "connections");
  const card = page.locator('[data-component="SpeechToTextCard"]');
  const modes = card.getByRole("radiogroup", { name: "Speech to text" });
  await expect(modes).toBeVisible();
  const micEnabled = () =>
    page.evaluate(async () => {
      const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
      return useUIStore.getState().speechToTextEnabled as boolean;
    });
  return { card, modes, saves, micEnabled };
}

// Off / Browser / Own server write the chat microphone key and the server's enabled flag together.
test("Speech to text modes write both stored keys", async ({ page }) => {
  const { modes, saves, micEnabled } = await openSpeechToTextCard(page, {
    calls: true,
    enabled: false,
    micEnabled: false,
  });
  await expect(modes.getByRole("radio", { name: "Off" })).toBeChecked();

  await modes.getByRole("radio", { name: "Browser" }).click();
  await expect(modes.getByRole("radio", { name: "Browser" })).toBeChecked();
  expect(await micEnabled()).toBe(true);
  await page.waitForTimeout(700);
  expect(saves).toHaveLength(0);

  await modes.getByRole("radio", { name: "Own server" }).click();
  await expect(modes.getByRole("radio", { name: "Own server" })).toBeChecked();
  expect(await micEnabled()).toBe(true);
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({ enabled: true });

  await modes.getByRole("radio", { name: "Off" }).click();
  await expect(modes.getByRole("radio", { name: "Off" })).toBeChecked();
  expect(await micEnabled()).toBe(false);
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]).toMatchObject({ enabled: false });
});

// Without Calls the card still shows, Off and Browser work, and Own server says what it needs.
test("Speech to text without Calls disables Own server and offers Get Calls", async ({ page }) => {
  const { card, modes, micEnabled } = await openSpeechToTextCard(page, {
    calls: false,
    enabled: false,
    micEnabled: false,
  });
  await expect(modes.getByRole("radio", { name: "Own server" })).toBeDisabled();
  await expect(card.getByText("Own server needs Calls.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Get Calls" })).toBeVisible();
  await modes.getByRole("radio", { name: "Browser" }).click();
  await expect(modes.getByRole("radio", { name: "Browser" })).toBeChecked();
  expect(await micEnabled()).toBe(true);
});
