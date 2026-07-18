export function SimulatedPaymentWarning() {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950" role="note">
      <strong>Simulated payment — development/test only.</strong> No real card or bank details are accepted or stored.
    </div>
  );
}

