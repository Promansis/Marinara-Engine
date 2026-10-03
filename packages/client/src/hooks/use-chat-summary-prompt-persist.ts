// ──────────────────────────────────────────────
// Shared persistence for global roleplay chat-summary prompt settings.
// Used by the summary popover (template selector) and the settings drawer
// (prompt/template editor) so both write through the same guarded queue.
// ──────────────────────────────────────────────
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  CHAT_SUMMARY_PROMPT_MAX_LENGTH,
  DEFAULT_CHAT_SUMMARY_COMBINE_PROMPT,
  type ChatSummaryPromptTemplate,
} from "@marinara-engine/shared";
import { useChatSummaryPromptSettings, useUpdateChatSummaryPromptSettings } from "./use-chat-summary-prompts";

export function useChatSummaryPromptPersist() {
  const query = useChatSummaryPromptSettings();
  const update = useUpdateChatSummaryPromptSettings();
  const { t } = useTranslation();
  const lockedRef = useRef(false);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const [saving, setSaving] = useState(false);

  const persist = useCallback(
    async (
      templates: ChatSummaryPromptTemplate[],
      activeTemplateId: string | null,
      combinePrompt: string,
    ): Promise<boolean> => {
      if (!query.isSuccess || lockedRef.current) return false;
      lockedRef.current = true;
      setSaving(true);
      const normalizedCombinePrompt =
        combinePrompt.trim().slice(0, CHAT_SUMMARY_PROMPT_MAX_LENGTH) || DEFAULT_CHAT_SUMMARY_COMBINE_PROMPT;
      const queuedSave = queueRef.current.then(async () => {
        try {
          await update.mutateAsync({ templates, activeTemplateId, combinePrompt: normalizedCombinePrompt });
          return true;
        } catch {
          toast.error(t("ui.chat.summarypopover.couldNotSaveGlobalSummaryPromptSettings"));
          return false;
        } finally {
          lockedRef.current = false;
          setSaving(false);
        }
      });
      queueRef.current = queuedSave.then(() => undefined);
      return queuedSave;
    },
    [query.isSuccess, t, update],
  );

  const isLocked = useCallback(() => lockedRef.current, []);
  const whenIdle = useCallback(() => queueRef.current, []);

  return { query, ready: query.isSuccess, saving, persist, isLocked, whenIdle };
}
