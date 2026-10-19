"use client";

import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

import { formatMinorCurrency } from "@/features/events/money";
import type {
  SelectionPriceTierView,
  SelectionSectionView,
} from "@/features/holds/inventory";
import {
  buildSelectionSeatIndex,
  describeSelectedSeats,
  estimateSelectionTotal,
  selectionLimitState,
} from "@/features/holds/selection";
import { cn } from "@/lib/utils";

/** Real session price tiers in configured order; renders nothing without tiers. */
export function PriceTierList({
  priceTiers,
}: {
  priceTiers: readonly SelectionPriceTierView[];
}) {
  if (priceTiers.length === 0) return null;
  return (
    <section aria-label="Seat categories and pricing" className="space-y-2">
      <h3 className="text-sm font-bold text-[var(--sf-text)]">Seat categories &amp; pricing</h3>
      <ul className="space-y-1 text-sm">
        {priceTiers.map((tier) => (
          <li key={tier.id} className="flex items-baseline justify-between gap-3">
            <span className="text-[var(--sf-text-secondary)]">
              {tier.name}
              {tier.description ? (
                <span className="block text-xs text-[var(--sf-text-muted)]">{tier.description}</span>
              ) : null}
            </span>
            <span className="font-mono font-bold tabular-nums text-[var(--sf-text)]">
              {formatMinorCurrency(tier.priceMinor, tier.currency)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Hold 1 seat" / "Hold 3 seats" — the action before a server-confirmed hold. */
export function holdActionLabel(count: number) {
  return count === 1 ? "Hold 1 seat" : `Hold ${count} seats`;
}

interface SelectionSummaryProps {
  /** Latest authoritative snapshot (prices and states come from here). */
  sections: readonly SelectionSectionView[];
  /** Real session tiers; shown as categories and used to name seat tiers. */
  priceTiers?: readonly SelectionPriceTierView[];
  selectedSeatIds: readonly string[];
  maxSeats: number;
  onRemoveSeat: (seatId: string) => void;
  onClearSelection: () => void;
  /**
   * "rail": desktop right-hand panel (SF-04 desktop).
   * "sheet": mobile bottom panel with safe-area padding (SF-04 mobile). It is
   * sticky, not fixed, so it stays in flow at the end of its container and
   * never covers the content (or footer) that follows it. On very short
   * viewports (≤340px tall, e.g. 400% zoom) it is not pinned at all.
   */
  variant: "rail" | "sheet";
  /** False when holding is impossible (signed out, not on sale, active hold). */
  holdEnabled?: boolean;
  /** A hold request is in flight. */
  pending?: boolean;
  /** Server message from the last hold attempt, shown as an alert. */
  errorMessage?: string;
  /** Why holding is currently paused, shown next to the hold action. */
  holdNotice?: ReactNode;
  className?: string;
}

/**
 * Selected seats, real price tiers and the estimated total for the current
 * local selection. Totals are integer minor units in the server currency, and
 * the copy never says the seats are reserved: the submit button only requests
 * a hold, which the server confirms (or rejects) separately. The button is a
 * plain submit button so the caller can place it inside its hold form.
 */
export function SelectionSummary({
  sections,
  priceTiers = [],
  selectedSeatIds,
  maxSeats,
  onRemoveSeat,
  onClearSelection,
  variant,
  holdEnabled = true,
  pending = false,
  errorMessage,
  holdNotice,
  className,
}: SelectionSummaryProps) {
  const headingId = useId();
  const detailsId = useId();
  const sheetRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);

  // While the sheet is shown (it is display:none from lg), reserve its height
  // as document scroll padding, so a control that receives keyboard focus is
  // scrolled clear of the sticky sheet instead of hiding behind it.
  useEffect(() => {
    const element = sheetRef.current;
    if (variant !== "sheet" || !element || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    // Only while it is actually sticky: on very short viewports (e.g. 400%
    // browser zoom) the sheet stays in flow and needs no reserved space.
    const apply = () => {
      const pinned = element.offsetHeight > 0 && getComputedStyle(element).position === "sticky";
      root.style.scrollPaddingBottom = pinned ? `${element.offsetHeight + 8}px` : "";
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
      root.style.scrollPaddingBottom = "";
    };
  }, [variant]);

  const seatIndex = useMemo(() => buildSelectionSeatIndex(sections), [sections]);
  const lines = describeSelectedSeats(selectedSeatIds, seatIndex);
  const estimate = estimateSelectionTotal(selectedSeatIds, seatIndex);
  const limit = selectionLimitState(selectedSeatIds, maxSeats);
  const tierNames = useMemo(
    () => new Map(priceTiers.map((tier) => [tier.id, tier.name])),
    [priceTiers],
  );
  const count = lines.length;
  const totalText =
    estimate.currency !== null ? formatMinorCurrency(estimate.totalMinor, estimate.currency) : "—";

  const seatList =
    count > 0 ? (
      <ul aria-label="Selected seats" className="space-y-2">
        {lines.map((line) => {
          const tierId = seatIndex.get(line.seatId)?.seat.priceTierId;
          const tierName = tierId ? tierNames.get(tierId) : undefined;
          const name = `${line.sectionName}, row ${line.rowLabel}, seat ${line.seatLabel}`;
          return (
            <li
              key={line.seatId}
              className="flex items-center gap-3 rounded-[var(--sf-radius-input)] border border-[var(--sf-border)] bg-[var(--sf-surface-raised)] p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-xs text-[var(--sf-text-muted)]">{line.sectionName}</p>
                <p className="font-bold text-[var(--sf-text)]">
                  Row {line.rowLabel} · Seat {line.seatLabel}
                </p>
                {tierName ? (
                  <p className="break-words text-xs text-[var(--sf-text-secondary)]">{tierName}</p>
                ) : null}
              </div>
              <p className="font-mono text-sm font-bold tabular-nums text-[var(--sf-text)]">
                {line.priceMinor !== null && line.currency !== null
                  ? formatMinorCurrency(line.priceMinor, line.currency)
                  : "Price confirmed when held"}
              </p>
              <button
                type="button"
                onClick={() => onRemoveSeat(line.seatId)}
                aria-label={`Remove ${name}`}
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-lg text-[var(--sf-text-secondary)] outline-none hover:bg-[var(--sf-surface-hover)] focus-visible:ring-4 focus-visible:ring-[var(--sf-focus)]"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </li>
          );
        })}
      </ul>
    ) : (
      <p className="text-sm text-[var(--sf-text-secondary)]">
        Select up to {maxSeats} seats on the map or from the seat list.
      </p>
    );

  const tierList = <PriceTierList priceTiers={priceTiers} />;

  const totalRow = (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-[var(--sf-text-secondary)]">
          Estimated total ({count} {count === 1 ? "seat" : "seats"})
        </p>
        <p className="font-mono text-2xl font-black tabular-nums text-[var(--sf-text)]" data-testid="selection-total">
          {totalText}
        </p>
      </div>
      {estimate.unpricedSeatIds.length > 0 ? (
        <p className="text-xs text-[var(--sf-warning)]">
          Some selected seats have no visible price. The server confirms every price when your hold is created.
        </p>
      ) : null}
    </div>
  );

  const estimateNote = (
    <p className="text-xs text-[var(--sf-text-muted)]">
      Estimate only. The server confirms availability and the official price when your hold is created.
    </p>
  );

  const holdMessages =
    errorMessage || holdNotice ? (
      <div className="space-y-2">
        {errorMessage ? (
          <p role="alert" className="rounded-[var(--sf-radius-input)] border border-[var(--sf-danger)] p-3 text-sm text-[var(--sf-danger)]">
            {errorMessage}
          </p>
        ) : null}
        {holdNotice}
      </div>
    ) : null;

  const holdButton = (
    <button
      type="submit"
      disabled={!holdEnabled || pending || count === 0}
      className="flex min-h-12 w-full items-center justify-center rounded-[var(--sf-radius-button)] bg-[var(--sf-brand)] px-5 text-base font-black text-[var(--sf-on-brand)] outline-none hover:bg-[var(--sf-brand-hover)] focus-visible:ring-4 focus-visible:ring-[var(--sf-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--sf-canvas)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? "Holding…" : holdActionLabel(count)}
    </button>
  );

  const clearAction =
    count > 0 ? (
      <button
        type="button"
        onClick={onClearSelection}
        className="flex min-h-11 w-full items-center justify-center rounded-[var(--sf-radius-button)] border border-[var(--sf-border)] px-5 text-sm font-bold text-[var(--sf-link)] outline-none hover:bg-[var(--sf-surface-hover)] focus-visible:ring-4 focus-visible:ring-[var(--sf-focus)]"
      >
        Clear selection
      </button>
    ) : null;

  const statusLine = (
    <div className="space-y-1">
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "text-[var(--sf-text-secondary)]",
          variant === "sheet" ? "text-xs leading-snug" : "text-sm",
        )}
      >
        {count > 0 ? "Seats selected — not reserved yet. " : ""}
        {limit.count} of {limit.maxSeats} seats selected.
      </p>
      {limit.atLimit ? (
        <p className="text-xs font-semibold text-[var(--sf-warning)]">
          You have reached the maximum of {limit.maxSeats} seats per hold.
        </p>
      ) : null}
    </div>
  );

  if (variant === "rail") {
    return (
      <aside
        data-theme-scope="customer"
        aria-labelledby={headingId}
        data-summary-variant="rail"
        className={cn(
          "space-y-5 rounded-[var(--sf-radius-card)] border border-[var(--sf-border)] bg-[var(--sf-surface)] p-5 text-[var(--sf-text)] lg:sticky lg:top-24",
          className,
        )}
      >
        <h2 id={headingId} className="text-xl font-black">
          Your selection
        </h2>
        {statusLine}
        {seatList}
        {tierList}
        <div className="space-y-1 border-t border-[var(--sf-border)] pt-4">
          {totalRow}
          {estimateNote}
        </div>
        <div className="space-y-2">
          {holdMessages}
          {holdButton}
          {clearAction}
        </div>
      </aside>
    );
  }

  return (
    <aside
      ref={sheetRef}
      data-theme-scope="customer"
      aria-labelledby={headingId}
      data-summary-variant="sheet"
      className={cn(
        "sticky bottom-0 z-30 max-h-[70dvh] [@media(max-height:340px)]:static [@media(max-height:340px)]:max-h-none overflow-y-auto rounded-t-[var(--sf-radius-hero)] border-t border-[var(--sf-border)] bg-[var(--sf-surface)] px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] text-[var(--sf-text)] shadow-[0_-12px_32px_rgb(0_0_0/0.35)]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        {/* Wraps instead of truncating, so the count stays visible at 320px. */}
        <h2 id={headingId} className="min-w-0 text-base font-black leading-tight">
          Selected seats ({count})
        </h2>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((current) => !current)}
          className="min-h-11 shrink-0 whitespace-nowrap rounded-[var(--sf-radius-button)] px-2 text-sm font-bold text-[var(--sf-link)] outline-none focus-visible:ring-4 focus-visible:ring-[var(--sf-focus)]"
        >
          {expanded ? "Hide details" : "View details"}
        </button>
      </div>
      {statusLine}
      {/* Collapsed, only the status, total and hold action stay visible so the
          sheet leaves room for the map on short phones; with nothing selected
          the hold row is omitted entirely. */}
      <div id={detailsId} hidden={!expanded} className="mt-3 space-y-4">
        {seatList}
        {tierList}
        {estimateNote}
        {clearAction}
      </div>
      {holdMessages ? <div className="mt-2">{holdMessages}</div> : null}
      {count > 0 ? (
        <div className="mt-3 space-y-1 border-t border-[var(--sf-border)] pt-3">
          <div className="flex items-center gap-3">
            <div className="shrink-0">
              <p className="text-xs leading-tight text-[var(--sf-text-secondary)]">Estimated total</p>
              <p className="font-mono text-lg font-black leading-tight tabular-nums" data-testid="selection-total">
                {totalText}
              </p>
            </div>
            <div className="min-w-0 flex-1">{holdButton}</div>
          </div>
          {estimate.unpricedSeatIds.length > 0 ? (
            <p className="text-xs text-[var(--sf-warning)]">
              Some selected seats have no visible price. The server confirms every price when your hold is created.
            </p>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
