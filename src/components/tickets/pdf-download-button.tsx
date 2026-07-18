"use client";

import { useState } from "react";

import { createBookingPdfDownloadAction } from "@/app/customer/tickets/actions";
import { Button, type ButtonSize } from "@/components/ui/button";

export function PdfDownloadButton({
  bookingReference,
  size = "md",
}: {
  bookingReference: string;
  size?: ButtonSize;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setPending(true);
    setError(null);
    try {
      const result = await createBookingPdfDownloadAction(bookingReference);
      if (!result) {
        setError("Ticket PDF is unavailable. Refresh and try again.");
        return;
      }
      window.location.assign(result.downloadUrl);
    } catch {
      setError("Ticket PDF could not be prepared. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <Button variant="outline" size={size} disabled={pending} onClick={() => void download()}>
        {pending ? "Preparing PDF…" : "Download booking PDF"}
      </Button>
      {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
