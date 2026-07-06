import {
  DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS,
  DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
  DEFAULT_LTM_EXTRACTION_TEMPERATURE,
  DEFAULT_LTM_EXTRACTION_VERBOSITY,
  ltmExtractionSettingsSchema,
  ltmResolvedExtractionSettingsSchema,
  DEFAULT_LTM_EXTRACTION_PROMPT,
  DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE,
  type LtmExtractionSettings,
  type LtmMode,
  type LtmResolvedExtractionSettings,
} from "@marinara-engine/shared";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";

const LTM_EXTRACTION_MODES = ["roleplay", "conversation", "game"] as const satisfies readonly LtmMode[];

export const DEFAULT_LTM_EXTRACTION_CONFIG = ltmResolvedExtractionSettingsSchema.parse({
  version: 1,
  systemPrompt: DEFAULT_LTM_EXTRACTION_PROMPT,
  extraInstruction: "",
  reasoningEffort: DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
  verbosity: DEFAULT_LTM_EXTRACTION_VERBOSITY,
  maxOutputTokens: DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  temperature: DEFAULT_LTM_EXTRACTION_TEMPERATURE,
  maxSourceTokens: DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS,
  maxExistingNoteTokens: DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
  existingNoteMaxChunks: DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS,
  existingNoteMaxTokens: DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS,
  promptTemplates: [],
  activePromptTemplateId: null,
  activePromptTemplateIdsByMode: {},
  aiKeywordExtraction: false,
  refinePass: false,
});

function extractionConfigPath(root = getLongTermMemoryRoot()) {
  return safeJoin(getLongTermMemoryDirectories(root).config, "extraction.json");
}

function defaultPromptForMode(mode: LtmMode): string {
  return DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE[mode];
}

type LtmPromptTemplate = NonNullable<LtmExtractionSettings["promptTemplates"]>[number];
type LtmActivePromptTemplateIdsByMode = Partial<Record<LtmMode, string | null>>;

function findTemplate(promptTemplates: readonly LtmPromptTemplate[], id: string | null | undefined) {
  if (!id) return null;
  return promptTemplates.find((candidate) => candidate.id === id) ?? null;
}

function normalizeActivePromptTemplateIdsByMode(
  input: LtmExtractionSettings,
  promptTemplates: readonly LtmPromptTemplate[],
): LtmActivePromptTemplateIdsByMode {
  const activeIds: LtmActivePromptTemplateIdsByMode = {};
  const modeIds = input.activePromptTemplateIdsByMode ?? {};

  for (const mode of LTM_EXTRACTION_MODES) {
    const modeId = modeIds[mode];
    if (typeof modeId === "string" && findTemplate(promptTemplates, modeId)) {
      activeIds[mode] = modeId;
    }
  }

  return activeIds;
}

function normalizePersistedConfig(input: LtmExtractionSettings): LtmExtractionSettings {
  const next: LtmExtractionSettings = { version: 1 };
  const extraInstruction = input.extraInstruction?.trim();
  const promptTemplates = Array.isArray(input.promptTemplates) ? input.promptTemplates.slice(0, 50) : [];
  const activePromptTemplateIdsByMode = normalizeActivePromptTemplateIdsByMode(input, promptTemplates);

  if (extraInstruction) next.extraInstruction = extraInstruction;
  if (input.reasoningEffort && input.reasoningEffort !== DEFAULT_LTM_EXTRACTION_CONFIG.reasoningEffort) {
    next.reasoningEffort = input.reasoningEffort;
  }
  if (input.verbosity && input.verbosity !== DEFAULT_LTM_EXTRACTION_CONFIG.verbosity) next.verbosity = input.verbosity;
  if (input.maxOutputTokens !== undefined && input.maxOutputTokens !== DEFAULT_LTM_EXTRACTION_CONFIG.maxOutputTokens) {
    next.maxOutputTokens = input.maxOutputTokens;
  }
  if (input.temperature !== undefined && input.temperature !== DEFAULT_LTM_EXTRACTION_CONFIG.temperature) {
    next.temperature = input.temperature;
  }
  if (input.maxSourceTokens !== undefined && input.maxSourceTokens !== DEFAULT_LTM_EXTRACTION_CONFIG.maxSourceTokens) {
    next.maxSourceTokens = input.maxSourceTokens;
  }
  if (
    input.maxExistingNoteTokens !== undefined &&
    input.maxExistingNoteTokens !== DEFAULT_LTM_EXTRACTION_CONFIG.maxExistingNoteTokens
  ) {
    next.maxExistingNoteTokens = input.maxExistingNoteTokens;
  }
  if (
    input.existingNoteMaxChunks !== undefined &&
    input.existingNoteMaxChunks !== DEFAULT_LTM_EXTRACTION_CONFIG.existingNoteMaxChunks
  ) {
    next.existingNoteMaxChunks = input.existingNoteMaxChunks;
  }
  if (
    input.existingNoteMaxTokens !== undefined &&
    input.existingNoteMaxTokens !== DEFAULT_LTM_EXTRACTION_CONFIG.existingNoteMaxTokens
  ) {
    next.existingNoteMaxTokens = input.existingNoteMaxTokens;
  }
  if (promptTemplates.length > 0) {
    next.promptTemplates = promptTemplates;
  }
  if (Object.keys(activePromptTemplateIdsByMode).length > 0) {
    next.activePromptTemplateIdsByMode = activePromptTemplateIdsByMode;
  }
  if (
    input.aiKeywordExtraction !== undefined &&
    input.aiKeywordExtraction !== DEFAULT_LTM_EXTRACTION_CONFIG.aiKeywordExtraction
  ) {
    next.aiKeywordExtraction = input.aiKeywordExtraction;
  }
  if (input.refinePass !== undefined && input.refinePass !== DEFAULT_LTM_EXTRACTION_CONFIG.refinePass) {
    next.refinePass = input.refinePass;
  }
  return next;
}

function resolveExtractionConfig(config: LtmExtractionSettings, mode?: LtmMode): LtmResolvedExtractionSettings {
  const resolvedMode = mode ?? "roleplay";
  const promptTemplates = config.promptTemplates ?? [];
  const activePromptTemplateIdsByMode = normalizeActivePromptTemplateIdsByMode(config, promptTemplates);
  const activePromptTemplateId = activePromptTemplateIdsByMode[resolvedMode] ?? null;
  const activeTemplate = findTemplate(promptTemplates, activePromptTemplateId);

  const systemPrompt = activeTemplate?.prompt.trim() || defaultPromptForMode(resolvedMode);

  const merged = {
    ...DEFAULT_LTM_EXTRACTION_CONFIG,
    ...config,
    version: 1 as const,
    systemPrompt,
    extraInstruction: config.extraInstruction?.trim() || "",
    promptTemplates,
    activePromptTemplateId: activeTemplate?.id ?? null,
    activePromptTemplateIdsByMode,
    aiKeywordExtraction: config.aiKeywordExtraction ?? DEFAULT_LTM_EXTRACTION_CONFIG.aiKeywordExtraction,
    refinePass: config.refinePass ?? DEFAULT_LTM_EXTRACTION_CONFIG.refinePass,
  };
  return ltmResolvedExtractionSettingsSchema.parse(merged);
}

export async function getLtmExtractionConfig(
  root = getLongTermMemoryRoot(),
  mode?: LtmMode,
): Promise<LtmResolvedExtractionSettings> {
  const raw = await readJsonFile<unknown>(extractionConfigPath(root), { version: 1 });
  return resolveExtractionConfig(ltmExtractionSettingsSchema.parse(raw), mode);
}

export async function updateLtmExtractionConfig(
  input: unknown,
  root = getLongTermMemoryRoot(),
): Promise<LtmResolvedExtractionSettings> {
  const parsed = normalizePersistedConfig(ltmExtractionSettingsSchema.parse(input ?? {}));
  await writeJsonAtomic(extractionConfigPath(root), parsed);
  return resolveExtractionConfig(parsed);
}
