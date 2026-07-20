"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  requestRefundAction,
  type RefundActionState,
} from "@/app/customer/refund-actions";
import type { SupportedCurrency } from "@/config/site";
import { formatMinorCurrency } from "@/features/events/money";

/**
 * Customer refund request.
 *
 * The form carries no amount and no currency. It names a booking, a scope, and
 * the customer's own seats; every figure shown here was calculated by the
 * server and is re-derived server-side on submit, so editing anything in the
 * page cannot change what is refunded.
 */

export interface RefundableSeatView {
  bookingSeatId: string;
  label: string;
  priceMinor: number;
  currency: SupportedCurrency;
  alreadyRefunded: boolean;
}

export interface RefundPanelProps {
  bookingReference: string;
  currency: SupportedCurrency;
  paidMinor: number;
  refundedMinor: number;
  inFlightMinor: number;
  maximumRefundableMinor: number;
  eligible: boolean;
  reason: string | null;
  seats: RefundableSeatView[];
  /** Stable per render so a double-click deduplicates to one request. */
  submissionNonce: string;
}

const INITIAL_STATE: RefundActionState = { status: "idle" };

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      // Disabled while pending, so a second click cannot even be issued. The
      // server-side idempotency key is the guarantee; this is the courtesy.
      disabled={disabled || pending}
      className="mt-5 w-full rounded-full bg-slate-950 px-6 py-3 text-sm font-bold text-white transition hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950 disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto"
    >
      {pending ? "Sending request…" : "Request refund"}
    </button>
  );
}

export function RefundRequestPanel(props: RefundPanelProps) {
  const [state, formAction] = useActionState(requestRefundAction, INITIAL_STATE);
  const [scope, setScope] = useState<"FULL_BOOKING" | "SELECTED_SEATS">("FULL_BOOKING");
  const [selectedSeats, setSelectedSeats] = useState<string[]>([]);
  const statusRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const scopeGroupId = useId();

  // Move focus to the outcome so a keyboard or screen-reader user is not left
  // wondering whether the submission did anything.
  useEffect(() => {
    if (state.status !== "idle") statusRef.current?.focus();
  }, [state]);

  const openSeats = props.seats.filter((seat) => !seat.alreadyRefunded);
  const selectedTotal = props.seats
    .filter((seat) => selectedSeats.includes(seat.bookingSeatId))
    .reduce((sum, seat) => sum + seat.priceMinor, 0);

  const proposedMinor =
    scope === "FULL_BOOKING" ? props.maximumRefundableMinor : selectedTotal;
  const canSubmit =
    props.eligible && (scope === "FULL_BOOKING" || selectedSeats.length > 0);

  return (
    <section
      aria-labelledby={headingId}
      className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h2 id={headingId} className="text-2xl font-black text-slate-950">
        Refunds
      </h2>

      <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Originally paid", value: props.paidMinor },
          { label: "Already refunded", value: props.refundedMinor },
          { label: "Refund in progress", value: props.inFlightMinor },
          { label: "Still refundable", value: props.maximumRefundableMinor },
        ].map((entry) => (
          <div key={entry.label} className="rounded-2xl bg-slate-50 p-4">
            <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">
              {entry.label}
            </dt>
            <dd className="mt-2 text-xl font-black text-slate-950">
              {formatMinorCurrency(entry.value, props.currency)}
            </dd>
          </div>
        ))}
      </dl>

      <div
        ref={statusRef}
        tabIndex={-1}
        // assertive: the outcome of a money request is worth interrupting for.
        role="status"
        aria-live="assertive"
        className={
          state.status === "idle"
            ? "sr-only"
            : `mt-5 rounded-2xl p-4 text-sm font-semibold ${
                state.status === "success"
                  ? "bg-emerald-50 text-emerald-900"
                  : "bg-rose-50 text-rose-900"
              }`
        }
      >
        {state.message ?? ""}
      </div>

      {!props.eligible ? (
        <p className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
          {props.reason === "UNDER_FINANCIAL_REVIEW"
            ? "This booking is under financial review. Our team will contact you before anything changes."
            : props.reason === "ALREADY_FULLY_REFUNDED"
              ? "This booking has been fully refunded."
              : "This booking is not currently eligible for a refund request."}
        </p>
      ) : (
        <form action={formAction} className="mt-6">
          <input type="hidden" name="bookingReference" value={props.bookingReference} />
          <input type="hidden" name="submissionNonce" value={props.submissionNonce} />
          <input type="hidden" name="scope" value={scope} />

          <fieldset>
            <legend
              id={scopeGroupId}
              className="text-xs font-bold uppercase tracking-wide text-slate-500"
            >
              What would you like refunded?
            </legend>
            <div className="mt-3 space-y-2">
              <label className="flex items-start gap-3 rounded-2xl border border-slate-200 p-3 has-checked:border-slate-950">
                <input
                  type="radio"
                  name="scopeChoice"
                  value="FULL_BOOKING"
                  checked={scope === "FULL_BOOKING"}
                  onChange={() => setScope("FULL_BOOKING")}
                  className="mt-1"
                />
                <span>
                  <span className="block font-bold text-slate-950">
                    Everything still refundable
                  </span>
                  <span className="block text-sm text-slate-600">
                    {formatMinorCurrency(props.maximumRefundableMinor, props.currency)}
                  </span>
                </span>
              </label>

              {openSeats.length > 1 ? (
                <label className="flex items-start gap-3 rounded-2xl border border-slate-200 p-3 has-checked:border-slate-950">
                  <input
                    type="radio"
                    name="scopeChoice"
                    value="SELECTED_SEATS"
                    checked={scope === "SELECTED_SEATS"}
                    onChange={() => setScope("SELECTED_SEATS")}
                    className="mt-1"
                  />
                  <span>
                    <span className="block font-bold text-slate-950">Specific seats</span>
                    <span className="block text-sm text-slate-600">
                      Choose which seats to refund
                    </span>
                  </span>
                </label>
              ) : null}
            </div>
          </fieldset>

          {scope === "SELECTED_SEATS" ? (
            <fieldset className="mt-5">
              <legend className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Seats to refund
              </legend>
              <ul className="mt-3 space-y-2">
                {props.seats.map((seat) => (
                  <li key={seat.bookingSeatId}>
                    <label
                      className={`flex items-center justify-between gap-3 rounded-2xl border p-3 ${
                        seat.alreadyRefunded
                          ? "border-slate-100 bg-slate-50 text-slate-400"
                          : "border-slate-200"
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          name="bookingSeatIds"
                          value={seat.bookingSeatId}
                          disabled={seat.alreadyRefunded}
                          checked={selectedSeats.includes(seat.bookingSeatId)}
                          onChange={(event) =>
                            setSelectedSeats((current) =>
                              event.target.checked
                                ? [...current, seat.bookingSeatId]
                                : current.filter((id) => id !== seat.bookingSeatId),
                            )
                          }
                        />
                        <span className="font-semibold">{seat.label}</span>
                      </span>
                      <span className="text-sm font-semibold">
                        {seat.alreadyRefunded
                          ? "Already refunded"
                          : formatMinorCurrency(seat.priceMinor, seat.currency)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : null}

          <p className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
            <span className="font-bold text-slate-950">
              Estimated refund: {formatMinorCurrency(proposedMinor, props.currency)}
            </span>
            <span className="mt-2 block">
              This amount is calculated from what you originally paid for these
              seats. Submitting sends a request to your payment provider; the
              money is only confirmed as returned once your provider settles it,
              which is usually a few business days. Refunded tickets stop being
              valid for entry.
            </span>
          </p>

          <SubmitButton disabled={!canSubmit} />
        </form>
      )}
    </section>
  );
}
