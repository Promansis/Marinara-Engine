// ──────────────────────────────────────────────
// Registered prompt-override keys: conversation-
// mode features (selfies, etc.)
// ──────────────────────────────────────────────
import type { PromptOverrideKeyDef } from "../types.js";

// ── Selfie wrapper ──
//
// The text LLM is asked to write the actual image prompt; this is the
// system prompt that drives that meta-step. The conditional "include
// these tags" line is pre-computed at the call site.

export interface ConversationSelfieCtx extends Record<string, string | number | undefined> {
  appearance: string;
  /**
   * The card's own appearance text, populated ONLY when an enabled appearance
   * override replaced `appearance` (#7243). Empty otherwise, so the default
   * builder stays byte-identical for cards without an override.
   *
   * Without it the prompt-builder saw the override alone and had no visual
   * context, so a bare token (e.g. a ComfyUI LoRA trigger) was discarded and the
   * model invented a look instead.
   */
  baseAppearance: string;
  charName: string;
  characterImageInstructions: string;
  personality: string;
  /**
   * Chat-level selfie tags to append to the meta-prompt. Currently always ""
   * at runtime — none of the call sites (resolveConversationSelfieSystemPrompt
   * callers) populate this field.
   */
  selfieTagsBlock: string;
}

export const CONVERSATION_SELFIE: PromptOverrideKeyDef<ConversationSelfieCtx> = {
  key: "conversation.selfie",
  description: "Meta-prompt that asks the chat LLM to write a selfie image prompt for the active character.",
  variables: [
    {
      name: "appearance",
      description: "Character appearance text.",
      example: "auburn hair, green eyes, leather jacket, mid-twenties, athletic build",
    },
    {
      name: "baseAppearance",
      description:
        "The character card's own appearance text, supplied as background context when an Image Appearance Override replaced ${appearance}. Empty when no override is set.",
      example: "auburn hair, green eyes, mid-twenties, athletic build, freckles",
    },
    { name: "charName", description: "Character display name.", example: "Lyra" },
    {
      name: "personality",
      description: "Character personality and traits that should influence the selfie naturally.",
      example: "reserved, observant, fascinated by old architecture",
    },
    {
      name: "characterImageInstructions",
      description: "Optional character-specific image quality, subject, camera, and composition instructions.",
      example: "Uses grainy 35mm film and prefers candid, imperfect framing.",
    },
    {
      name: "selfieTagsBlock",
      description:
        "Pre-formatted block listing chat-level selfie tags. Empty when none, otherwise begins with two newlines to preserve the blank line above.",
      example: "\n\nAlways include these tags/modifiers in the prompt: masterpiece, best quality, sharp focus",
    },
  ],
  defaultBuilder: (ctx) =>
    [
      `You are an image prompt generator. Create a concise, detailed image generation prompt for a selfie photo.`,
      // #7243: with an override in play, `appearance` holds the override's tags and
      // `baseAppearance` the card text it replaced. The override is authoritative
      // and must survive the rewrite verbatim (a ComfyUI LoRA trigger has no visual
      // meaning, so a model left to interpret it drops it); the card text is context
      // only, present so the model can still dress and stage the character.
      //
      // With no override, `baseAppearance` is empty and this collapses back to the
      // original single line, byte for byte.
      `The character's appearance: ${ctx.appearance}`,
      ...(ctx.baseAppearance
        ? [
            `Include those appearance tags in your prompt exactly as written, character for character. Do not reword, reorder, translate, or omit any of them, even if a tag is not a word you recognize — it may be a LoRA trigger or another identifier the image model needs verbatim.`,
            `Background context (do NOT copy this text into the prompt; use it only to render the character, their build, and what they are wearing): ${ctx.baseAppearance}`,
          ]
        : []),
      `Character name: ${ctx.charName}`,
      ...(ctx.personality
        ? [
            `Character personality and traits: ${ctx.personality}`,
            `Let those traits naturally affect the subject, expression, quality, camera habits, and composition.`,
          ]
        : []),
      ...(ctx.characterImageInstructions
        ? [`Character-specific image instructions: ${ctx.characterImageInstructions}`]
        : []),
      ``,
      `Generate a prompt that describes a selfie photo of this character. Include:`,
      `- Physical appearance details (face, hair, eyes, skin)`,
      `- What they're wearing`,
      `- Expression and pose (selfie angle)`,
      `- Setting/background from context`,
      `- Lighting and mood`,
      ``,
      `Infer the appropriate art style from the character. For example, anime/game characters should use anime/illustration style, realistic characters should use photorealistic style. Match the style to the character's origin.${ctx.selfieTagsBlock}`,
      `Output ONLY the prompt text, nothing else.`,
    ].join("\n"),
  exampleContext: {
    appearance: "auburn hair, green eyes, leather jacket, mid-twenties, athletic build",
    // Left empty on purpose: the default path (no override) is what most users see,
    // and an empty baseAppearance keeps the previewed default identical to it.
    baseAppearance: "",
    charName: "Lyra",
    personality: "reserved, observant, fascinated by old architecture",
    characterImageInstructions: "Uses grainy 35mm film and prefers candid, imperfect framing.",
    selfieTagsBlock: "\n\nAlways include these tags/modifiers in the prompt: masterpiece, best quality, sharp focus",
  },
};
