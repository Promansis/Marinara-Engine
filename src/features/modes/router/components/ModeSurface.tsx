import { Suspense, lazy, useEffect } from "react";
import { useChat } from "../../../catalog/chats/index";
import { ApiError } from "../../../../shared/api/api-errors";
import { useChatStore } from "../../../../shared/stores/chat.store";
import { ModeHomeSurface } from "./ModeHomeSurface";

const ConversationModeRoute = lazy(async () => {
  const module = await import("../../conversation/index");
  return { default: module.ConversationModeRoute };
});

const RoleplayModeRoute = lazy(async () => {
  const module = await import("../../roleplay/index");
  return { default: module.RoleplayModeRoute };
});

const GameModeRoute = lazy(async () => {
  const module = await import("../../game/index");
  return { default: module.GameModeRoute };
});

export function ModeSurface() {
  const activeChatId = useChatStore((state) => state.activeChatId);
  const setActiveChatId = useChatStore((state) => state.setActiveChatId);
  const { data: chat, error: chatError } = useChat(activeChatId);

  useEffect(() => {
    if (!activeChatId || !(chatError instanceof ApiError) || chatError.status !== 404) return;
    setActiveChatId(null);
  }, [activeChatId, chatError, setActiveChatId]);

  if (!activeChatId) return <ModeHomeSurface />;

  if (!chat?.mode) return <OpeningChatState />;

  return (
    <Suspense fallback={<OpeningChatState />}>
      {chat.mode === "game" ? (
        <GameModeRoute activeChatId={activeChatId} />
      ) : chat.mode === "conversation" ? (
        <ConversationModeRoute activeChatId={activeChatId} />
      ) : (
        <RoleplayModeRoute activeChatId={activeChatId} fallbackChatMode="roleplay" />
      )}
    </Suspense>
  );
}

function OpeningChatState() {
  return (
    <div className="flex flex-1 items-center justify-center overflow-hidden text-sm text-[var(--muted-foreground)]">
      Opening chat...
    </div>
  );
}
