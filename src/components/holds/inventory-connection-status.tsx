import {
  toConnectionStateView,
  type RealtimeConnectionState,
} from "@/features/inventory-events/delivery";
import { cn } from "@/lib/utils";

export function InventoryConnectionStatus({
  state,
}: {
  state: RealtimeConnectionState;
}) {
  const view = toConnectionStateView(state);
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold",
        view.tone === "success" && "border-emerald-200 bg-emerald-50 text-emerald-800",
        view.tone === "warning" && "border-amber-200 bg-amber-50 text-amber-800",
        view.tone === "neutral" && "border-slate-200 bg-slate-100 text-slate-700",
      )}
      role="status"
      aria-live="polite"
    >
      <span
        className={cn(
          "size-2 rounded-full",
          view.tone === "success" && "bg-emerald-500",
          view.tone === "warning" && "bg-amber-500",
          view.tone === "neutral" && "bg-slate-400",
        )}
      />
      {view.label}
    </div>
  );
}
