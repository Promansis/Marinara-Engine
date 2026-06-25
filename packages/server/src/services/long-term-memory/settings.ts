import {
  DEFAULT_LTM_GLOBAL_SETTINGS,
  LTM_RECALL_STYLE_WEIGHTS,
  ltmGlobalSettingsSchema,
  ltmResolvedGlobalSettingsSchema,
  parseLongTermMemoryRecallStyle,
  type LtmGlobalSettings,
  type LtmResolvedGlobalSettings,
} from "@marinara-engine/shared";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";

function settingsPath(root = getLongTermMemoryRoot()) {
  return safeJoin(getLongTermMemoryDirectories(root).config, "settings.json");
}

function normalizeText(value: string | undefined, max: number) {
  return value?.trim().slice(0, max) ?? "";
}

const RECALL_WEIGHT_KEYS = [
  "longTermMemorySemanticWeight",
  "longTermMemoryLexicalWeight",
  "longTermMemoryGraphWeight",
  "longTermMemoryMetadataWeight",
  "longTermMemoryKeywordWeight",
] as const satisfies Array<keyof LtmGlobalSettings>;

function setRecallWeightOverride<K extends keyof Pick<
  LtmGlobalSettings,
  | "longTermMemorySemanticWeight"
  | "longTermMemoryLexicalWeight"
  | "longTermMemoryGraphWeight"
  | "longTermMemoryMetadataWeight"
  | "longTermMemoryKeywordWeight"
>>(
  target: LtmGlobalSettings,
  key: K,
  value: LtmGlobalSettings[K],
  styleDefault: LtmGlobalSettings[K],
) {
  if (value === null || value === undefined || value === styleDefault) return;
  target[key] = value;
}

function normalizePersistedSettings(input: LtmGlobalSettings): LtmGlobalSettings {
  const recallStyle = parseLongTermMemoryRecallStyle(input.longTermMemoryRecallStyle);
  const styleWeights = LTM_RECALL_STYLE_WEIGHTS[recallStyle];
  const next: LtmGlobalSettings = { version: 1 };

  const setIfChanged = <K extends keyof LtmGlobalSettings>(key: K, value: LtmGlobalSettings[K]) => {
    if (value !== DEFAULT_LTM_GLOBAL_SETTINGS[key]) next[key] = value;
  };

  setIfChanged("enableLongTermMemory", input.enableLongTermMemory ?? DEFAULT_LTM_GLOBAL_SETTINGS.enableLongTermMemory);
  setIfChanged(
    "longTermMemoryBudgetTokens",
    input.longTermMemoryBudgetTokens ?? DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryBudgetTokens,
  );
  setIfChanged(
    "longTermMemoryMaxChunks",
    input.longTermMemoryMaxChunks ?? DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryMaxChunks,
  );
  setIfChanged(
    "longTermMemoryScoreThreshold",
    input.longTermMemoryScoreThreshold ?? DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryScoreThreshold,
  );
  setIfChanged(
    "longTermMemoryRecallContextMessages",
    input.longTermMemoryRecallContextMessages ?? DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryRecallContextMessages,
  );
  setIfChanged("longTermMemoryRecallStyle", recallStyle);
  setRecallWeightOverride(
    next,
    "longTermMemorySemanticWeight",
    input.longTermMemorySemanticWeight,
    styleWeights.semanticWeight,
  );
  setRecallWeightOverride(
    next,
    "longTermMemoryLexicalWeight",
    input.longTermMemoryLexicalWeight,
    styleWeights.lexicalWeight,
  );
  setRecallWeightOverride(next, "longTermMemoryGraphWeight", input.longTermMemoryGraphWeight, styleWeights.graphWeight);
  setRecallWeightOverride(
    next,
    "longTermMemoryMetadataWeight",
    input.longTermMemoryMetadataWeight,
    styleWeights.metadataWeight,
  );
  setRecallWeightOverride(
    next,
    "longTermMemoryKeywordWeight",
    input.longTermMemoryKeywordWeight,
    styleWeights.keywordWeight,
  );
  setIfChanged(
    "longTermMemoryIncludeResolved",
    input.longTermMemoryIncludeResolved ?? DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryIncludeResolved,
  );
  setIfChanged(
    "longTermMemoryRecallPreamble",
    input.longTermMemoryRecallPreamble === undefined
      ? DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryRecallPreamble
      : normalizeText(input.longTermMemoryRecallPreamble, 500),
  );
  setIfChanged("longTermMemoryDebug", input.longTermMemoryDebug ?? DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryDebug);

  return next;
}

function resolveGlobalSettings(config: LtmGlobalSettings): LtmResolvedGlobalSettings {
  const recallStyle = parseLongTermMemoryRecallStyle(config.longTermMemoryRecallStyle);
  const styleWeights = LTM_RECALL_STYLE_WEIGHTS[recallStyle];
  return ltmResolvedGlobalSettingsSchema.parse({
    ...DEFAULT_LTM_GLOBAL_SETTINGS,
    ...config,
    version: 1,
    longTermMemoryRecallStyle: recallStyle,
    longTermMemorySemanticWeight: config.longTermMemorySemanticWeight ?? styleWeights.semanticWeight,
    longTermMemoryLexicalWeight: config.longTermMemoryLexicalWeight ?? styleWeights.lexicalWeight,
    longTermMemoryGraphWeight: config.longTermMemoryGraphWeight ?? styleWeights.graphWeight,
    longTermMemoryMetadataWeight: config.longTermMemoryMetadataWeight ?? styleWeights.metadataWeight,
    longTermMemoryKeywordWeight: config.longTermMemoryKeywordWeight ?? styleWeights.keywordWeight,
    longTermMemoryRecallPreamble:
      config.longTermMemoryRecallPreamble === undefined
        ? DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryRecallPreamble
        : normalizeText(config.longTermMemoryRecallPreamble, 500),
  });
}

export async function getLtmGlobalSettings(root = getLongTermMemoryRoot()): Promise<LtmResolvedGlobalSettings> {
  const raw = await readJsonFile<unknown>(settingsPath(root), { version: 1 });
  return resolveGlobalSettings(ltmGlobalSettingsSchema.parse(raw));
}

export async function updateLtmGlobalSettings(
  input: unknown,
  root = getLongTermMemoryRoot(),
): Promise<LtmResolvedGlobalSettings> {
  const existingRaw = await readJsonFile<unknown>(settingsPath(root), { version: 1 });
  const existing = ltmGlobalSettingsSchema.parse(existingRaw);
  const patch = ltmGlobalSettingsSchema.parse(input ?? {});
  const styleChanged =
    patch.longTermMemoryRecallStyle !== undefined && patch.longTermMemoryRecallStyle !== existing.longTermMemoryRecallStyle;
  const patchClearsWeights = styleChanged && RECALL_WEIGHT_KEYS.every((key) => patch[key] === undefined);
  const merged: LtmGlobalSettings = { ...existing, ...patch, version: 1 };
  if (patchClearsWeights) {
    for (const key of RECALL_WEIGHT_KEYS) {
      merged[key] = null;
    }
  }
  const parsed = normalizePersistedSettings(merged);
  await writeJsonAtomic(settingsPath(root), parsed);
  return resolveGlobalSettings(parsed);
}
