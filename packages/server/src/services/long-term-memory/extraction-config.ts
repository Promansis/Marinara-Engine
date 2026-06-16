import {
  ltmExtractionSettingsSchema,
  ltmResolvedExtractionSettingsSchema,
  type LtmExtractionSettings,
  type LtmResolvedExtractionSettings,
} from "@marinara-engine/shared";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import {
  DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_CHARS,
  DEFAULT_LTM_EXTRACTION_MAX_SOURCE_CHARS,
  DEFAULT_LTM_EXTRACTION_PROMPT,
  DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
  DEFAULT_LTM_EXTRACTION_VERBOSITY,
} from "./evidence-unit-extraction.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";

export const DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS = 12;
export const DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS = 2_400;

export const DEFAULT_LTM_EXTRACTION_CONFIG = ltmResolvedExtractionSettingsSchema.parse({
  version: 1,
  systemPrompt: DEFAULT_LTM_EXTRACTION_PROMPT,
  extraInstruction: "",
  reasoningEffort: DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
  verbosity: DEFAULT_LTM_EXTRACTION_VERBOSITY,
  maxOutputTokens: DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  temperature: 0,
  maxSourceChars: DEFAULT_LTM_EXTRACTION_MAX_SOURCE_CHARS,
  maxExistingNoteChars: DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_CHARS,
  existingNoteMaxChunks: DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS,
  existingNoteMaxTokens: DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS,
  rejectPlaceholderOutput: true,
  promptTemplates: [],
  activePromptTemplateId: null,
});

function extractionConfigPath(root = getLongTermMemoryRoot()) {
  return safeJoin(getLongTermMemoryDirectories(root).config, "extraction.json");
}

function normalizePersistedConfig(input: LtmExtractionSettings): LtmExtractionSettings {
  const next: LtmExtractionSettings = { version: 1 };
  const systemPrompt = input.systemPrompt?.trim();
  const extraInstruction = input.extraInstruction?.trim();
  if (systemPrompt && systemPrompt !== DEFAULT_LTM_EXTRACTION_CONFIG.systemPrompt) next.systemPrompt = systemPrompt;
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
  if (input.maxSourceChars !== undefined && input.maxSourceChars !== DEFAULT_LTM_EXTRACTION_CONFIG.maxSourceChars) {
    next.maxSourceChars = input.maxSourceChars;
  }
  if (
    input.maxExistingNoteChars !== undefined &&
    input.maxExistingNoteChars !== DEFAULT_LTM_EXTRACTION_CONFIG.maxExistingNoteChars
  ) {
    next.maxExistingNoteChars = input.maxExistingNoteChars;
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
  if (
    input.rejectPlaceholderOutput !== undefined &&
    input.rejectPlaceholderOutput !== DEFAULT_LTM_EXTRACTION_CONFIG.rejectPlaceholderOutput
  ) {
    next.rejectPlaceholderOutput = input.rejectPlaceholderOutput;
  }
  if (Array.isArray(input.promptTemplates) && input.promptTemplates.length > 0) {
    next.promptTemplates = input.promptTemplates.slice(0, 50);
  }
  if (input.activePromptTemplateId !== undefined) {
    next.activePromptTemplateId = input.activePromptTemplateId;
  }
  return next;
}

function resolveExtractionConfig(config: LtmExtractionSettings): LtmResolvedExtractionSettings {
  const promptTemplates = config.promptTemplates ?? [];
  const activePromptTemplate = config.activePromptTemplateId
    ? promptTemplates.find((template) => template.id === config.activePromptTemplateId) ?? null
    : null;
  const merged = {
    ...DEFAULT_LTM_EXTRACTION_CONFIG,
    ...config,
    version: 1 as const,
    systemPrompt:
      activePromptTemplate?.prompt.trim() ||
      config.systemPrompt?.trim() ||
      DEFAULT_LTM_EXTRACTION_CONFIG.systemPrompt,
    extraInstruction: config.extraInstruction?.trim() || "",
    promptTemplates,
    activePromptTemplateId: activePromptTemplate ? activePromptTemplate.id : null,
  };
  return ltmResolvedExtractionSettingsSchema.parse(merged);
}

export async function getLtmExtractionConfig(root = getLongTermMemoryRoot()): Promise<LtmResolvedExtractionSettings> {
  const raw = await readJsonFile<unknown>(extractionConfigPath(root), { version: 1 });
  return resolveExtractionConfig(ltmExtractionSettingsSchema.parse(raw));
}

export async function updateLtmExtractionConfig(
  input: unknown,
  root = getLongTermMemoryRoot(),
): Promise<LtmResolvedExtractionSettings> {
  const parsed = normalizePersistedConfig(ltmExtractionSettingsSchema.parse(input ?? {}));
  await writeJsonAtomic(extractionConfigPath(root), parsed);
  return resolveExtractionConfig(parsed);
}
