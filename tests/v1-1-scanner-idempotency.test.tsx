import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScannerPanel } from "@/components/tickets/scanner-panel";
import {
  resolveScanAttempt,
  shouldRetainScanAttempt,
} from "@/features/tickets/scan-attempt";

const credentialA = `SFT1.${"A".repeat(43)}`;
const credentialB = `SFT1.${"B".repeat(43)}`;

describe("scan attempt idempotency", () => {
  it("reuses the pending key only for the identical credential and session", () => {
    let counter = 0;
    const createKey = () => `key-${++counter}`;
    const first = resolveScanAttempt(null, { credential: credentialA, sessionId: "s1" }, createKey);
    expect(first.idempotencyKey).toBe("key-1");
    expect(resolveScanAttempt(first, { credential: credentialA, sessionId: "s1" }, createKey)).toBe(first);
    expect(resolveScanAttempt(first, { credential: credentialB, sessionId: "s1" }, createKey).idempotencyKey).toBe("key-2");
    expect(resolveScanAttempt(first, { credential: credentialA, sessionId: "s2" }, createKey).idempotencyKey).toBe("key-3");
  });

  it.each([
    ["network-error", true],
    [{ status: 500 }, true],
    [{ status: 503 }, true],
    [{ status: 429 }, true],
    [{ status: 200 }, false],
    [{ status: 400 }, false],
    [{ status: 401 }, false],
    [{ status: 403 }, false],
    [{ status: 409 }, false],
    [{ status: 413 }, false],
  ] as const)("retains the key after %o: %s", (response, retained) => {
    expect(shouldRetainScanAttempt(response)).toBe(retained);
  });
});

function submittedKeys(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(
    ([, init]) => JSON.parse(String((init as RequestInit).body)).idempotencyKey as string,
  );
}

function submit(credential: string) {
  fireEvent.change(screen.getByLabelText(/manual credential fallback/i), { target: { value: credential } });
  fireEvent.submit(screen.getByLabelText(/manual credential fallback/i).closest("form")!);
}

describe("scanner retries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries a scan whose response was lost under the same key", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ outcome: "ACCEPTED", accepted: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScannerPanel sessionId="session-safe" />);

    submit(credentialA);
    await waitFor(() => expect(screen.getByText(/retrying this ticket is safe/i)).toBeInTheDocument());
    // The credential stays in the field so the operator can retry it.
    expect(screen.getByLabelText(/manual credential fallback/i)).toHaveValue(credentialA);

    submit(credentialA);
    await waitFor(() => expect(screen.getByText("ACCEPTED")).toBeInTheDocument());
    const [first, second] = submittedKeys(fetchMock);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toBe(first);
  });

  it("keeps the key across a server error and rate limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => { throw new SyntaxError("html"); } })
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: "Rate limited." }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ outcome: "ACCEPTED", accepted: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScannerPanel sessionId="session-safe" />);

    submit(credentialA);
    await waitFor(() => expect(screen.getByText(/could not confirm this ticket yet/i)).toBeInTheDocument());
    submit(credentialA);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Validate with SeatFlow" })).toBeEnabled());
    submit(credentialA);
    await waitFor(() => expect(screen.getByText("ACCEPTED")).toBeInTheDocument());
    expect(new Set(submittedKeys(fetchMock)).size).toBe(1);
  });

  it("uses a fresh key once the server has answered definitively", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ outcome: "ACCEPTED", accepted: true }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ outcome: "ALREADY_USED", accepted: false }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScannerPanel sessionId="session-safe" />);

    submit(credentialA);
    await waitFor(() => expect(screen.getByText("ACCEPTED")).toBeInTheDocument());
    submit(credentialA);
    await waitFor(() => expect(screen.getByText("ALREADY USED")).toBeInTheDocument());
    const [first, second] = submittedKeys(fetchMock);
    expect(second).not.toBe(first);
  });

  it("makes no request and no entry decision while offline", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    try {
      render(<ScannerPanel sessionId="session-safe" />);
      await waitFor(() => expect(screen.getByText("OFFLINE")).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText(/manual credential fallback/i), { target: { value: credentialA } });
      expect(screen.getByRole("button", { name: "Validate with SeatFlow" })).toBeDisabled();
      // A submit that bypasses the disabled button (camera path, Enter key) is refused too.
      fireEvent.submit(screen.getByLabelText(/manual credential fallback/i).closest("form")!);
      await waitFor(() => expect(screen.getByText(/cannot validate tickets offline/i)).toBeInTheDocument());
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByText("Accepted")).not.toBeInTheDocument();
    } finally {
      onLine.mockRestore();
    }
  });

  it("shows a key conflict as a rejection and never as acceptance", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: "This scan key was already used for a different ticket. Scan again." }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScannerPanel sessionId="session-safe" />);

    submit(credentialB);
    await waitFor(() => expect(screen.getByText(/already used for a different ticket/i)).toBeInTheDocument());
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(screen.queryByText("Accepted")).not.toBeInTheDocument();
  });
});
