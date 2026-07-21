import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  HowItWorksSection,
  OrganizerSection,
  TrustSection,
} from "@/components/home/marketing-sections";
import { SiteFooter } from "@/components/layout/site-footer";

/**
 * Public-copy accuracy for the staging demo.
 *
 * The first deployment shipped marketing and footer copy that still described
 * seat selection, checkout, bookings, and reporting as unbuilt ("arrive in
 * later phases", "remain on the roadmap", "Phase 5B secure ticketing"). Those
 * features now exist, so the copy must reflect them — while staying honest that
 * payments are simulated — and must not leak internal phase names into public
 * marketing.
 */

function renderedText(node: React.ReactElement) {
  return render(node).container.textContent ?? "";
}

const PUBLIC_COPY = [
  renderedText(<HowItWorksSection />),
  renderedText(<OrganizerSection />),
  renderedText(<TrustSection />),
  renderedText(<SiteFooter />),
].join("\n");

describe("public staging-demo copy", () => {
  it("no longer claims shipped features are on the roadmap", () => {
    for (const stale of [
      "on the roadmap",
      "later phase",
      "later phases",
      "arrive in later",
      "before checkout exists",
    ]) {
      expect(PUBLIC_COPY.toLowerCase()).not.toContain(stale.toLowerCase());
    }
  });

  it("leaks no internal phase name into public marketing", () => {
    // e.g. "Phase 4A", "Phase 5B", "Phase 5C2B".
    expect(PUBLIC_COPY).not.toMatch(/Phase\s*\d/i);
  });

  it("describes the capabilities the demo actually ships", () => {
    const lowered = PUBLIC_COPY.toLowerCase();
    expect(lowered).toContain("seats");
    expect(lowered).toContain("checkout");
    expect(lowered).toContain("bookings");
    expect(lowered).toContain("digital tickets");
    expect(lowered).toContain("reporting");
  });

  it("stays honest that checkout is simulated and no money moves", () => {
    const lowered = PUBLIC_COPY.toLowerCase();
    expect(lowered).toContain("simulated");
    // At least one plain-language money disclaimer is present.
    expect(
      lowered.includes("no money moves") ||
        lowered.includes("no real payment") ||
        lowered.includes("takes no real payment"),
    ).toBe(true);
  });

  it("keeps the footer free of a phase label", () => {
    const footer = renderedText(<SiteFooter />);
    expect(footer).not.toMatch(/Phase\s*\d/i);
    expect(footer.toLowerCase()).toContain("seatflow");
  });
});
