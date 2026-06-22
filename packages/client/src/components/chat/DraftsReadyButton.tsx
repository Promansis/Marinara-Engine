import { BrainCircuit } from "lucide-react";
import { usePendingDraftsCount } from "../../hooks/use-long-term-memory";
import { ChatToolbarButton } from "./ChatToolbarControls";

type Props = {
  onOpenVault: () => void;
};

export function DraftsReadyButton({ onOpenVault }: Props) {
  const { data } = usePendingDraftsCount();
  const count = data?.count ?? 0;
  if (count === 0) return null;
  return (
    <ChatToolbarButton
      icon={
        <span className="relative">
          <BrainCircuit size="0.875rem" />
          <span className="absolute -right-1.5 -top-1.5 flex min-h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-1 text-[0.5625rem] font-bold text-black leading-none">
            {count > 99 ? "99+" : count}
          </span>
        </span>
      }
      title={`${count} draft${count === 1 ? "" : "s"} ready for review`}
      onClick={onOpenVault}
    />
  );
}
