import { useEffect, useRef, useState } from "react";
import { CircleStop, Folder, HardDrive, Video } from "lucide-react";
import { getRecorderConfig, getRecorderStatus, makeLog, startRecorder, stopRecorder, type LogEntry } from "../api/backend";
import LogPanel from "./LogPanel";

const sessionName = () => new Date().toISOString().replace(/[:.]/g, "-");
const duration = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
export default function RecordPage({ recording, onRecordingChange }: {
  recording: boolean; onRecordingChange: (value: boolean) => void;
}) {
  const [config, setConfig] = useState<Awaited<ReturnType<typeof getRecorderConfig>> | null>(null);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getRecorderStatus>> | null>(null);
  const [name, setName] = useState(sessionName);
  const [directory, setDirectory] = useState("");
  const [fps, setFps] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const after = useRef(0);
  const initialized = useRef(false);
  useEffect(() => {
    let active = true;
    let timer: number;
    const poll = async () => {
      try {
        const [next, sources] = await Promise.all([getRecorderStatus(after.current), getRecorderConfig()]);
        if (!active) return;
        setConnectionError(""); setConfig(sources); setStatus(next); onRecordingChange(next.recording);
        if (!initialized.current) {
          setDirectory(next.session?.saveDirectory ?? sources.saveDirectory);
          setName(next.recording && next.session ? next.session.name : sessionName());
          setFps(sources.fps); initialized.current = true;
        }
        if (next.logs.length) {
          after.current = next.logs[next.logs.length - 1].id;
          setLogs((current) => [...current, ...next.logs.map((line) => makeLog(line.id, line.message,
            line.stream === "stderr" ? "warning" : "info"))].slice(-2000));
        }
        setSeconds(next.startedAt ? Math.floor((Date.now() - next.startedAt) / 1000) : 0);
      } catch (reason) { if (active) setConnectionError(reason instanceof Error ? reason.message : "Recorder service unavailable"); }
      finally { if (active) timer = window.setTimeout(() => void poll(), 1000); }
    };
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [onRecordingChange]);
  const toggle = async () => {
    setBusy(true); setError("");
    try {
      if (recording) {
        await stopRecorder(); onRecordingChange(false); setName(sessionName());
      } else {
        await startRecorder(name, directory, "camera", fps); onRecordingChange(true);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Recording command failed"); }
    finally { setBusy(false); }
  };
  const dropped = status?.progress?.dropped_frames.reduce((sum, value) => sum + value, 0) ?? 0;
  return <div className="page">
    <header className="page-header"><div><p className="eyebrow">Synchronized capture</p><h1>Record</h1>
      <p>Save aligned camera videos using ROS image timestamps.</p></div></header>
    {(error || connectionError || status?.error) && <p className="settings-error" role="alert">{error || connectionError || status?.error}</p>}
    {status?.calibrationRunning && <p className="recorder-note">Calibration is running. Finish or cancel it before starting a recording.</p>}
    <section className={recording ? "record-hero surface active" : "record-hero surface"}>
      <div className="recording-state"><span className="record-orb" /><div>
        <span>{recording ? status?.ready ? "RECORDING" : "PREPARING / FINALIZING" : "READY TO RECORD"}</span>
        <strong>{duration(seconds)}</strong><small>{status?.progress ? `${status.progress.frames} aligned frames per camera` : "All cameras must deliver RGB8 images at the same resolution"}</small>
      </div></div>
      <button className={recording ? "stop-button" : "record-button"}
        disabled={busy || Boolean(status?.calibrationRunning) || (!recording && (!config || !name.trim() || !directory.trim()))} onClick={toggle}>
        {recording ? <CircleStop size={18} /> : <span className="button-record-dot" />}
        {busy ? "Please wait…" : recording ? "Stop recording" : "Start recording"}
      </button>
    </section>
    <div className="two-column-layout record-layout">
      <section className="surface settings-card">
        <div className="section-title"><div className="title-icon"><Folder size={19} /></div><div><h2>Session settings</h2><p>A new folder is created for each session.</p></div></div>
        <div className="form-stack">
          <label>Session name<input value={name} disabled={recording || busy} onChange={(event) => setName(event.target.value)} /></label>
          <label>Save directory<input value={directory} disabled={recording || busy} onChange={(event) => setDirectory(event.target.value)} /></label>
          <label>Recording frequency (Hz)<input type="number" min="1" max="240" value={fps} disabled={recording || busy} onChange={(event) => setFps(Number(event.target.value))} /></label>
          <p className="recorder-note">Output: <code>{directory}/{name}</code></p>
          <p className="recorder-note">Each camera produces an MP4 video. Timestamp and session files document frame alignment and unmatched frames. The maximum timestamp difference is {config?.syncToleranceMs ?? 5} ms.</p>
          {status?.session && <p className="recorder-note">Latest session: <code>{status.session.outputDirectory}</code></p>}
          {dropped > 0 && <p className="recorder-note">{dropped} unmatched or buffered input frames were dropped. Saved frame indices remain aligned across videos.</p>}
        </div>
      </section>
      <section className="surface source-list">
        <div className="section-title"><div className="title-icon"><Video size={19} /></div><div><h2>Sources</h2><p>{config?.cameras.length ?? 0} configured cameras</p></div></div>
        {config?.cameras.map((camera) => <div className="source-row" key={camera.serial}>
          <span className={camera.online ? "source-check" : "source-check offline"}><span /></span>
          <div><strong>Camera {camera.serial}</strong><small>{camera.width ? `${camera.width} × ${camera.height}` : "Waiting for images"} · {camera.inputFps.toFixed(1)} Hz input</small></div>
          <span className="source-ready">{camera.online ? "Online" : "Offline"}</span>
        </div>)}
        <div className="storage"><HardDrive size={17} /><div><span>Storage location</span><strong>{directory || "Loading…"}</strong></div></div>
      </section>
    </div>
    <LogPanel title="Recorder output" logs={logs} onClear={() => setLogs([])} />
  </div>;
}
