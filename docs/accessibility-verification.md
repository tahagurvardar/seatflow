# SeatFlow accessibility verification report

**Date:** 2026-07-19 · **Phase:** 5C1 · **Method:** automated structural audit in
a real browser plus manual inspection of component source.

> **This is not a WCAG conformance claim.** It reports exactly what was tested,
> what passed, and what remains unverified. Several success criteria — notably
> colour contrast and full screen-reader behaviour — were **not** audited and are
> listed as gaps.

## How this was tested

- Chromium at 1280×720 (desktop), 390×844 (mobile), and 640×360 (equivalent to
  200% zoom on a 1280×720 viewport).
- A structural audit script executed in-page checking heading order, labels,
  accessible names, landmark structure, focusable interactive elements, target
  sizes, and horizontal overflow.
- Browser console inspected for errors and hydration warnings.
- Component source reviewed for live regions, `sr-only` text, and focus styling.

No external accessibility library was loaded: the Content Security Policy blocks
external scripts, and adding `axe-core` as a dependency was out of scope for this
phase. The audit script therefore checks structure mechanically but **cannot**
evaluate contrast ratios or assistive-technology output.

## Pages inspected

| Page | Inspected | Notes |
| --- | --- | --- |
| Landing (`/`) | full audit | Skip link, landmarks, one `h1`, no heading jumps |
| Login (`/login`) | full audit | Labels, autocomplete, live region for errors |
| Register (`/register`) | shared component audit | Same `auth-form` component as login |
| Events catalogue (`/events`) | source audit | `aria-live="polite"` result count |
| Seat selection | source audit | `role="status"` / `role="alert"` regions |
| Hold detail | source audit | Countdown semantics reviewed |
| Checkout | source audit | `role="status"` summary |
| Booking list/detail | source audit | Shared summary components |
| Ticket list/detail | source audit | QR alternative text reviewed |
| Organizer session | source audit | Realtime inventory `role="status"` |
| Scanner | source audit | `aria-live` result region |
| Health/admin | n/a | JSON endpoints, no UI |

Authenticated pages were audited from component source rather than driven
end-to-end in the browser, because this environment has no seeded customer or
organizer session. That is a real limitation of this report.

## Results

### Passed

| Criterion | Evidence |
| --- | --- |
| Skip link to main content | `a[href="#main-content"]` present and first in tab order |
| Landmark structure | `banner`, `navigation`, `main`, `contentinfo` all present |
| Named navigation | "Primary navigation" and "Mobile navigation" labelled |
| Heading hierarchy | Exactly one `h1`; no skipped levels on audited pages |
| Form labels | Every control labelled; zero unlabeled controls found |
| Autocomplete | `email` / `current-password` set on the login form |
| Accessible names on controls | Zero buttons or links without an accessible name |
| Images | Zero `img` elements without `alt`; decorative SVG uses `aria-hidden` |
| Keyboard operability | Zero click-handling elements that are not natively focusable |
| Disclosure pattern | Mobile navigation uses native `<details>/<summary>` with `sr-only` label and a `focus-visible` ring |
| Visible focus | No global `outline: none`; 14 interactive elements add explicit `focus-visible:ring`, the remainder retain the browser default |
| Error announcement | `aria-live="polite" aria-atomic="true"` in `auth-form`, organizer and venue onboarding forms |
| Status announcement | `role="status"` in checkout summary, seat selection, connection status, organizer inventory, scanner |
| Alerts | `role="alert"` for seat-map and form failures |
| Countdown accessibility | Ticking value is `aria-live="off"`; only the terminal expiry state uses `role="status"`, avoiding a per-second announcement storm |
| Colour-independent state | Seat and connection states carry text/`sr-only` labels alongside colour |
| Reduced motion | `@media (prefers-reduced-motion: reduce)` neutralizes animation and transition durations globally |
| 200% zoom | 640×360: no horizontal overflow, no clipped non-decorative content, navigation reachable |
| 390×844 mobile | No page-level horizontal overflow (`scrollWidth` 390 = `innerWidth` 390) |
| No console errors | Only React DevTools info and HMR messages; no hydration warnings |

### Fixed in this phase

**Target size (WCAG 2.2 SC 2.5.8, Level AA).** Twelve links — three hero
"Explore" chips and nine footer navigation links — rendered 16–18 px tall,
below the 24×24 CSS-pixel minimum. These are list and chip links, not links
inline within a sentence, so the inline exception does not apply.

Fixed by adding `inline-block py-1` in
[hero-section.tsx](src/components/home/hero-section.tsx) and
[site-footer.tsx](src/components/layout/site-footer.tsx), lifting them to
24–26 px. Re-audited: **0 undersized targets remain**, with no layout change and
no new overflow at any tested viewport.

## Known gaps — not verified

These are stated plainly rather than assumed to pass:

1. **Colour contrast (SC 1.4.3 / 1.4.11) was not measured.** No contrast tooling
   was run. The palette uses slate/orange on white and white on dark in the
   footer; several combinations look marginal by eye and need real measurement.
2. **No screen-reader testing.** Nothing was verified with NVDA, JAWS, or
   VoiceOver. Live regions are present in the markup, but whether announcements
   are timely, ordered, and non-duplicative is unconfirmed.
3. **Authenticated flows not driven end-to-end.** Seat selection, hold detail,
   checkout, tickets, and scanner were audited from source only. Dialog focus
   trapping, focus restoration after a modal closes, and focus management after
   a server action were therefore **not** observed in a browser.
4. **Camera-unavailable messaging unverified.** The scanner's fallback path
   exists in source but was not exercised with a denied or absent camera.
5. **Seat-map accessible alternative is partial.** The map exposes per-seat
   labels and status, but there is no verified non-visual way to browse a large
   section efficiently. A keyboard user can reach seats; whether that is usable
   at scale is untested.
6. **QR textual alternative not confirmed end-to-end.** The ticket page renders a
   public reference alongside the QR image, but the rendered alternative text was
   not inspected in a browser session.
7. **Zoom tested by viewport emulation**, not by real browser zoom. Reflow
   behaviour matched expectations, but text-only zoom (SC 1.4.4) and 320 px
   reflow (SC 1.4.10) were not separately verified.
8. **No automated regression.** Accessibility is not yet asserted in CI, so these
   findings can regress silently.

## Recommended next steps

1. Add `axe-core` to the component test suite and assert zero violations on the
   audited pages, so the results above become a regression gate.
2. Measure contrast programmatically and fix any pair below 4.5:1 (text) or
   3:1 (UI components).
3. Drive the authenticated flows with a seeded session and verify dialog focus
   behaviour, focus restoration, and live-region timing.
4. Test one full purchase and one full scan with a real screen reader.
