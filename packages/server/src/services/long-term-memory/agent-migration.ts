import { isManagedAgentType, type LtmResolvedGlobalSettings } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createAgentsStorage } from "../storage/agents.storage.js";
import type { DB } from "../../db/connection.js";

const LTM_AGENT_TYPE = "long-term-memory";

interface MigrationSummary {
  scanned: number;
  migrated: number;
  skippedAlreadyMigrated: number;
  agentConfigSeeded: boolean;
  errors: number;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeActiveAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Migrate per-chat LTM enablement from the legacy `enableLongTermMemory`
 * metadata flag to the per-chat agent toggle system (`activeAgentIds`).
 *
 * Idempotent: only adds "long-term-memory" to `activeAgentIds` if it is
 * not already present and the chat has `enableLongTermMemory: true`.
 * Running this twice is a no-op the second time.
 *
 * Dry-run mode: when `process.env.LTM_MIGRATION_DRY_RUN === "1"`, logs
 * what would be migrated without writing anything.
 */
export async function migrateLtmChatsForAgentPipeline(
  db: DB,
  ltmGlobalSettings?: LtmResolvedGlobalSettings | null,
): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    scanned: 0,
    migrated: 0,
    skippedAlreadyMigrated: 0,
    agentConfigSeeded: false,
    errors: 0,
  };

  const isDryRun = process.env.LTM_MIGRATION_DRY_RUN === "1";
  const chatsStore = createChatsStorage(db);
  const agentsStore = createAgentsStorage(db);

  // ── Seed the LTM agent config row if missing ──
  try {
    if (!(await agentsStore.getByType(LTM_AGENT_TYPE))) {
      if (isDryRun) {
        logger.info(
          "[ltm-migration] Dry-run: would create agent_config for type=%s",
          LTM_AGENT_TYPE,
        );
      } else {
        const defaultSettings: Record<string, unknown> = {};
        if (ltmGlobalSettings) {
          defaultSettings.connectionId = ltmGlobalSettings.connectionId ?? null;
          defaultSettings.model = ltmGlobalSettings.model ?? "";
          defaultSettings.instruction = ltmGlobalSettings.instruction ?? "";
          defaultSettings.extractionMode = ltmGlobalSettings.extractionMode ?? "fast";
          defaultSettings.importConcurrency = ltmGlobalSettings.importConcurrency ?? 3;
          defaultSettings.autoApplyLowRisk = ltmGlobalSettings.autoApplyLowRisk ?? false;
          defaultSettings.longTermMemoryBudgetTokens = ltmGlobalSettings.longTermMemoryBudgetTokens ?? 2048;
          defaultSettings.longTermMemoryMaxChunks = ltmGlobalSettings.longTermMemoryMaxChunks ?? 12;
          defaultSettings.longTermMemoryScoreThreshold = ltmGlobalSettings.longTermMemoryScoreThreshold ?? 0;
          defaultSettings.longTermMemoryRecallContextMessages = ltmGlobalSettings.longTermMemoryRecallContextMessages ?? 4;
          defaultSettings.longTermMemoryRecallStyle = ltmGlobalSettings.longTermMemoryRecallStyle ?? "balanced";
          defaultSettings.longTermMemoryIncludeResolved = ltmGlobalSettings.longTermMemoryIncludeResolved ?? false;
          defaultSettings.longTermMemoryDebug = ltmGlobalSettings.longTermMemoryDebug ?? false;
        }
        const created = await agentsStore.create({
          type: LTM_AGENT_TYPE,
          name: "Long-Term Memory",
          description: "Retrieves and injects relevant memories from the long-term memory vault.",
          phase: "pre_generation",
          enabled: true,
          imagePath: null,
          connectionId: null,
          promptTemplate: "",
          settings: defaultSettings,
        });
        if (created) {
          summary.agentConfigSeeded = true;
          logger.info("[ltm-migration] Created agent_config for type=%s (id=%s)", LTM_AGENT_TYPE, created.id);
        }
      }
    }
  } catch (err) {
    summary.errors += 1;
    logger.error(err, "[ltm-migration] Failed to seed agent config for %s", LTM_AGENT_TYPE);
  }

  // ── Migrate per-chat enablement ──
  try {
    const allChats = await chatsStore.list();
    summary.scanned = allChats.length;

    for (const chat of allChats) {
      try {
        const metadata = parseMetadata(chat.metadata);
        const enabled = metadata.enableLongTermMemory === true;
        const activeAgentIds = normalizeActiveAgentIds(metadata.activeAgentIds);

        if (enabled && !activeAgentIds.includes(LTM_AGENT_TYPE)) {
          const patchedActiveAgentIds = [...activeAgentIds, LTM_AGENT_TYPE];

          if (isDryRun) {
            logger.info(
              "[ltm-migration] Dry-run: would patch chat=%s — current activeAgentIds=%j → patched=%j, enableLongTermMemory=true",
              chat.id,
              activeAgentIds,
              patchedActiveAgentIds,
            );
            summary.migrated += 1;
          } else {
            await chatsStore.patchMetadata(chat.id, {
              activeAgentIds: patchedActiveAgentIds,
            } as Record<string, unknown>);
            summary.migrated += 1;
            logger.debug(
              "[ltm-migration] Patched chat=%s — added long-term-memory to activeAgentIds",
              chat.id,
            );
          }
        } else {
          summary.skippedAlreadyMigrated += 1;
        }
      } catch (err) {
        summary.errors += 1;
        logger.error(err, "[ltm-migration] Failed to process chat=%s", chat.id);
      }
    }
  } catch (err) {
    summary.errors += 1;
    logger.error(err, "[ltm-migration] Failed to list chats");
  }

  if (summary.migrated > 0 || summary.agentConfigSeeded || summary.errors > 0) {
    logger.info(
      "[ltm-migration] Done: scanned=%d migrated=%d already-migrated=%d agent-config-seeded=%s errors=%d%s",
      summary.scanned,
      summary.migrated,
      summary.skippedAlreadyMigrated,
      summary.agentConfigSeeded ? "yes" : "no",
      summary.errors,
      isDryRun ? " (DRY RUN)" : "",
    );
  }

  return summary;
}
