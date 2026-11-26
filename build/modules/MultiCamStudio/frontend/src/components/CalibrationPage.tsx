import { useEffect, useRef, useState } from "react";
import { Box, Check, ChevronRight, CircleX, Copy, Film, Image, LoaderCircle, Play } from "lucide-react";
import { calibrationCommand, getCalibrationStatus, calibrationGuideUrl, calibrationResultUrl,
  latestCalibrationJsonUrl, makeLog, type CalibrationStatus, type CalibrationStage, type LogEntry } from "../api/backend";
import LogPanel from "./LogPanel";
import Calibration3DDialog from "./Calibration3DDialog";

const stages: Array<{ id: CalibrationStage; label: string }> = [
  { id: "capture", label: "Capture" }, { id: "calibrate", label: "Calibrate" }, { id: "validate", label: "Validate" },
];
export default function CalibrationPage() {
  const [status, setStatus] = useState<CalibrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [latestAvailable, setLatestAvailable] = useState(false);
  const [guideExpanded, setGuideExpanded] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [show3D, setShow3D] = useState(false);
  const [copied, setCopied] = useState(false);
  const after = useRef(0);
  useEffect(() => {
    let active = true;
    let timer: number;
    const poll = async () => {
      try {
        const value = await getCalibrationStatus(after.current);
        const available = (await fetch(latestCalibrationJsonUrl, { method: "HEAD", cache: "no-store" })).ok;
        if (!active) return;
        setConnectionError(""); setStatus(value); setLatestAvailable(available);
        if (value.logs.length) {
          after.current = value.logs[value.logs.length - 1].id;
          setLogs((current) => [...current, ...value.logs.map((line) => makeLog(line.id, line.message,
            line.stream === "stderr" ? "warning" : "info"))].slice(-2000));
        }
      } catch (reason) { if (active) setConnectionError(reason instanceof Error ? reason.message : "Calibration service unavailable"); }
      finally { if (active) timer = window.setTimeout(() => void poll(), 1000); }
    };
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, []);
  const command = async (action: "run" | "validate" | "cancel") => {
    setBusy(true); setError(""); setCopied(false);
    try {
      await calibrationCommand(action);
      setStatus(await getCalibrationStatus());
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Calibration command failed"); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try {
      const response = await fetch(latestCalibrationJsonUrl);
      if (!response.ok) throw new Error("No calibration available");
      await navigator.clipboard.writeText(await response.text()); setCopied(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not copy calibration"); }
  };
  const running = busy || status?.running;
  return <div className="page">
    <header className="page-header"><div><p className="eyebrow">Lens alignment</p><h1>Calibration</h1>
      <p>Capture synchronized images, solve camera parameters, and validate against live ROS images.</p></div></header>
    {(error || connectionError) && <p className="settings-error" role="alert">{error || connectionError}</p>}
    <section className="step-strip surface">
      {stages.map((stage, index) => {
        const state = status?.stages[stage.id] ?? "pending";
        return <div className="step" key={stage.id}><span className={`step-number ${state}`}>
          {state === "running" ? <LoaderCircle className="stage-spinner" size={15} /> : state === "success" ? <Check size={15} /> : state === "error" ? <CircleX size={15} /> : `0${index + 1}`}
        </span><div><strong>{stage.label}</strong><small>{state}</small></div>{index < 2 && <ChevronRight size={17} />}</div>;
      })}
      <div className="quick-validation-action"><button className="secondary-button" disabled={Boolean(running) || !latestAvailable} onClick={() => void command("validate")}>Quick validation</button>
        <small>Check the latest calibration using a new synchronized image set.</small></div>
    </section>
    <div className="two-column-layout">
      <section className="surface settings-card">
        <div className="section-title"><div className="title-icon"><Film size={19} /></div><div><h2>Calibration guide</h2><p>Move the board through different positions and angles, visible in every camera.</p></div></div>
        <button className={`gif-placeholder expandable${guideExpanded ? " fullscreen" : ""}`} onClick={() => setGuideExpanded(!guideExpanded)}>
          <img className="calibration-guide-gif" src={calibrationGuideUrl} alt="Move the calibration board through the camera views" />
        </button>
        <p className="recorder-note">All cameras must deliver RGB8 images at the same resolution. Capture starts when synchronized frames arrive. Keep the board visible for live validation after capture.</p>
        {status?.captureProgress && status.running && <p className="recorder-note">Captured {status.captureProgress.frames} / {status.captureProgress.target_frames} synchronized image sets.</p>}
        <button className="primary-button full" disabled={Boolean(running) || !status} onClick={() => void command("run")}><Play size={17} />{running ? "Calibration running…" : "Run calibration"}</button>
        {status?.running && <button className="secondary-button full" disabled={busy} onClick={() => void command("cancel")}>Cancel calibration</button>}
        {status?.sessionDirectory && <p className="recorder-note">Session: <code>{status.sessionDirectory}</code></p>}
      </section>
      <section className="surface preview-card">
        <div className="section-title"><div className="title-icon"><Image size={19} /></div><div><h2>Validation preview</h2><p>Green: detected corners · Red: reprojected corners</p></div></div>
        {status?.result?.resultAvailable && !status.running ? <button className={`validation-preview expandable${previewExpanded ? " fullscreen" : ""}`} onClick={() => setPreviewExpanded(!previewExpanded)}>
          <img className="calibration-result" src={`${calibrationResultUrl}?v=${status.result.finishedAt ?? 0}`} alt="Calibration reprojection on the reference camera" />
        </button> : <div className="validation-preview"><p>{running ? "Waiting for validation…" : "Run calibration or quick validation to check the result."}</p></div>}
        {status?.result && !status.running && <p className={status.result.success ? "settings-success" : "settings-error"} role="status">
          {status.result.success ? "Calibration validation passed." : status.result.error}
        </p>}
        {status?.result?.report && <p className="recorder-note">Mean reprojection error: {status.result.report.mean_reprojection_error_px.toFixed(2)} px · {status.result.report.points} shared corners</p>}
        <div className="calibration-result-actions">
          <button className="secondary-button" disabled={!latestAvailable || Boolean(running)} onClick={() => setShow3D(true)}><Box size={15} />3D view</button>
          <button className="secondary-button" disabled={!latestAvailable || Boolean(running)} onClick={() => void copy()}><Copy size={15} />{copied ? "Copied" : "Copy calibration"}</button>
        </div>
      </section>
    </div>
    <LogPanel title="Calibration output" logs={logs} onClear={() => setLogs([])} />
    {show3D && <Calibration3DDialog onClose={() => setShow3D(false)} />}
  </div>;
}
