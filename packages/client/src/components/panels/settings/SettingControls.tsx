import { useEffect, useState } from "react";
import { Bell, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { useUIStore } from "../../../stores/ui.store";
import {
  getLocalNotificationPermission,
  requestLocalNotificationPermission,
  type LocalNotificationPermission,
} from "../../../lib/local-notifications";
import { playNotificationPing } from "../../../lib/notification-sound";
import { HelpTooltip } from "../../ui/HelpTooltip";

export function ConversationSoundSetting() {
  const convoNotificationSound = useUIStore((s) => s.convoNotificationSound);
  const setConvoNotificationSound = useUIStore((s) => s.setConvoNotificationSound);
  const rpNotificationSound = useUIStore((s) => s.rpNotificationSound);
  const setRpNotificationSound = useUIStore((s) => s.setRpNotificationSound);
  const conversationBrowserNotifications = useUIStore((s) => s.conversationBrowserNotifications);
  const setConversationBrowserNotifications = useUIStore((s) => s.setConversationBrowserNotifications);
  const [browserPermission, setBrowserPermission] = useState<LocalNotificationPermission>("default");

  useEffect(() => {
    let cancelled = false;
    void getLocalNotificationPermission().then((permission) => {
      if (!cancelled) setBrowserPermission(permission);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleBrowserNotificationToggle = (enabled: boolean) => {
    if (!enabled) {
      setConversationBrowserNotifications(false);
      return;
    }

    void requestLocalNotificationPermission().then((permission) => {
      setBrowserPermission(permission);
      if (permission === "granted") {
        setConversationBrowserNotifications(true);
        toast.success("Browser notifications enabled for background Conversation replies.");
        return;
      }
      setConversationBrowserNotifications(false);
      toast.error(
        permission === "unsupported"
          ? "Browser notifications are not available in this environment."
          : "Browser notification permission was not granted.",
      );
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Volume2 size="0.75rem" className="text-[var(--muted-foreground)]" />
        <span className="text-xs font-medium">Notification Sounds</span>
        <HelpTooltip text="Play a notification ping when you receive a new message while on a different chat." />
      </div>
      <ToggleSetting
        label="Conversation mode"
        checked={convoNotificationSound}
        onChange={(v) => {
          setConvoNotificationSound(v);
          if (v) playNotificationPing();
        }}
      />
      <ToggleSetting
        label="Roleplay mode"
        checked={rpNotificationSound}
        onChange={(v) => {
          setRpNotificationSound(v);
          if (v) playNotificationPing();
        }}
      />
      <div className="mt-1 flex items-center gap-1.5">
        <Bell size="0.75rem" className="text-[var(--muted-foreground)]" />
        <span className="text-xs font-medium">Browser Notifications</span>
        <HelpTooltip text="Show an operating-system browser notification when a background Conversation reply arrives while Marinara is not focused. Message content is hidden." />
      </div>
      <ToggleSetting
        label="Background Conversation replies"
        checked={conversationBrowserNotifications && browserPermission === "granted"}
        onChange={handleBrowserNotificationToggle}
      />
    </div>
  );
}

export function ToggleSetting({
  label,
  checked,
  onChange,
  help,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  help?: string;
}) {
  return (
    <label className="flex items-center gap-2.5 rounded-lg p-1 transition-colors hover:bg-[var(--secondary)]/50">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
      />
      <span className="text-xs">{label}</span>
      {help && (
        <span onClick={(e) => e.preventDefault()}>
          <HelpTooltip text={help} />
        </span>
      )}
    </label>
  );
}
