"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

interface ScanResult {
  outcome: string;
  accepted: boolean;
  ticket?: {
    reference: string;
    eventTitle: string;
    venueName: string;
    sectionName: string;
    rowLabel: string;
    seatLabel: string;
  };
}

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorInstance {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}

type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorInstance;

export function ScannerPanel({ sessionId }: { sessionId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const [credential, setCredential] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [message, setMessage] = useState("Camera is off. Manual entry is always available.");
  const [cameraActive, setCameraActive] = useState(false);
  // Keep the server and first client render identical; the effect reconciles
  // the browser's live connectivity immediately after hydration.
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const stopCamera = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);
    setMessage("Camera is off. Manual entry is always available.");
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const submitCredential = useCallback(async (value: string, source: "camera" | "manual") => {
    const normalized = value.trim();
    if (!normalized || busyRef.current) return;
    if (!navigator.onLine) {
      setResult({ outcome: "OFFLINE", accepted: false });
      setMessage("SeatFlow cannot validate tickets offline. Reconnect and try again.");
      return;
    }
    busyRef.current = true;
    setMessage("Checking authoritative ticket state…");
    try {
      const response = await fetch("/api/tickets/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credential: normalized,
          sessionId,
          idempotencyKey: crypto.randomUUID().replaceAll("-", ""),
          scannerIdentifier: source === "camera" ? "web-camera" : "web-manual",
        }),
      });
      const payload = await response.json() as ScanResult & { error?: string };
      if (!response.ok && !payload.outcome) throw new Error(payload.error ?? "Validation failed.");
      setResult(payload);
      setMessage(payload.accepted ? "Entry accepted." : `Entry rejected: ${payload.outcome.replaceAll("_", " ").toLowerCase()}.`);
      setCredential("");
    } catch {
      setResult({ outcome: "NETWORK_ERROR", accepted: false });
      setMessage("SeatFlow could not validate this ticket. No offline decision was made.");
    } finally {
      busyRef.current = false;
    }
  }, [sessionId]);

  const startCamera = useCallback(async () => {
    setResult(null);
    const Detector = (window as Window & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
    if (!navigator.mediaDevices?.getUserMedia || !Detector) {
      setMessage("Camera QR detection is unavailable in this browser. Use manual entry below.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraActive(true);
      setMessage("Camera is ready. Hold one QR code inside the frame.");
      const detector = new Detector({ formats: ["qr_code"] });
      const inspect = async () => {
        if (!videoRef.current || !streamRef.current) return;
        if (!busyRef.current) {
          try {
            const codes = await detector.detect(videoRef.current);
            const value = codes[0]?.rawValue;
            if (value) await submitCredential(value, "camera");
          } catch {
            setMessage("Camera detection paused. Manual entry remains available.");
          }
        }
        frameRef.current = requestAnimationFrame(inspect);
      };
      frameRef.current = requestAnimationFrame(inspect);
    } catch {
      stopCamera();
      setMessage("Camera permission was unavailable. Use manual entry below.");
    }
  }, [stopCamera, submitCredential]);

  return (
    <div className="mx-auto w-full max-w-md overflow-hidden rounded-[1.75rem] border border-slate-800 bg-slate-950 text-white shadow-2xl shadow-slate-950/20">
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-300">Network validation</p><h1 className="mt-2 text-2xl font-black">Scan ticket</h1></div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${online ? "bg-emerald-400/15 text-emerald-200" : "bg-red-400/15 text-red-200"}`}>{online ? "ONLINE" : "OFFLINE"}</span>
        </div>
        <div className="relative mt-5 aspect-[4/3] min-h-56 overflow-hidden rounded-2xl bg-slate-900 ring-1 ring-white/10">
          <video ref={videoRef} muted playsInline className="h-full w-full object-cover" aria-label="Ticket QR camera preview" />
          {!cameraActive ? <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-slate-400">Start the camera or use the controlled manual fallback.</div> : null}
          <div aria-hidden="true" className="pointer-events-none absolute inset-7 rounded-2xl border-2 border-emerald-300/80" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Button size="md" className="min-h-11" onClick={startCamera} disabled={cameraActive}>Start camera</Button>
          <Button size="md" variant="outline" className="min-h-11 border-white/20 bg-transparent text-white hover:bg-white/10" onClick={stopCamera} disabled={!cameraActive}>Stop camera</Button>
        </div>
        <p className="mt-3 min-h-10 text-sm text-slate-300" role="status">{message}</p>
      </div>
      {result ? (
        <section className={`border-y p-5 ${result.accepted ? "border-emerald-400/30 bg-emerald-400/10" : "border-red-400/30 bg-red-400/10"}`} aria-live="assertive">
          <p className={`text-xs font-black uppercase tracking-[0.18em] ${result.accepted ? "text-emerald-300" : "text-red-300"}`}>{result.accepted ? "Accepted" : "Rejected"}</p>
          <p className="mt-2 text-2xl font-black">{result.outcome.replaceAll("_", " ")}</p>
          {result.ticket ? <div className="mt-3 text-sm text-slate-200"><p className="font-bold">{result.ticket.eventTitle}</p><p>{result.ticket.sectionName} · Row {result.ticket.rowLabel} · Seat {result.ticket.seatLabel}</p><p className="mt-1 break-all font-mono text-xs text-slate-400">{result.ticket.reference}</p></div> : null}
        </section>
      ) : null}
      <form className="p-4 sm:p-5" onSubmit={(event) => { event.preventDefault(); void submitCredential(credential, "manual"); }}>
        <label htmlFor="manual-ticket-credential" className="text-sm font-bold text-slate-200">Manual credential fallback</label>
        <input id="manual-ticket-credential" value={credential} onChange={(event) => setCredential(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} placeholder="SFT1.…" className="mt-2 h-12 w-full min-w-0 rounded-xl border border-slate-700 bg-slate-900 px-4 font-mono text-sm text-white outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-400/30" />
        <Button type="submit" size="md" className="mt-3 min-h-12 w-full" disabled={!credential.trim() || !online}>Validate with SeatFlow</Button>
        <p className="mt-3 text-xs leading-5 text-slate-400">Offline validation is not supported. No local or cached result authorizes entry.</p>
      </form>
    </div>
  );
}
