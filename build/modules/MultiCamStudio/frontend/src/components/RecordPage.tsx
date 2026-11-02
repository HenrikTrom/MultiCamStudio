import { useEffect, useRef, useState } from "react";
import { CircleStop, Folder, HardDrive, Video } from "lucide-react";
import { getRecorderConfig, getRecorderStatus, makeLog, startRecorder, stopRecorder, type LogEntry, type RecorderMode } from "../api/backend";
import LogPanel from "./LogPanel";
import EyeTrackerStatusPanel from "./EyeTrackerStatusPanel";

const formatDuration = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
const timestampName = () => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
};

export default function RecordPage({
  recording,
  onRecordingChange,
  mode = "camera",
}: {
  recording: boolean;
  onRecordingChange: (recording: boolean) => void;
  mode?: RecorderMode;
}) {
  const [seconds, setSeconds] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [recordingName, setRecordingName] = useState(timestampName);
  const [saveDirectory, setSaveDirectory] = useState("");
  const [config, setConfig] = useState<Awaited<ReturnType<typeof getRecorderConfig>> | null>(null);
  const [activeMode, setActiveMode] = useState<RecorderMode | null>(null);
  const [ready, setReady] = useState(false);
  const [statusError, setStatusError] = useState("");
  const thisRecording = recording && activeMode === mode;
  const otherRecording = recording && activeMode !== mode;
  const lastLogId = useRef(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    let active = true;
    void getRecorderConfig().then((value) => {
      if (!active) return;
      setConfig(value);
      setSaveDirectory(value.saveDirectory);
    }).catch((error: unknown) => {
      if (active) setLogs((current) => [...current, makeLog(Date.now(), error instanceof Error ? error.message : "Could not load recorder settings", "warning")]);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const status = await getRecorderStatus(lastLogId.current);
        if (!active) return;
        onRecordingChange(status.recording);
        setActiveMode(status.mode);
        setReady(status.ready);
        setStatusError("");
        setStartedAt(status.startedAt);
        if (status.recording && status.mode === mode && status.session) {
          setRecordingName(status.session.name);
          setSaveDirectory(status.session.saveDirectory);
        }
        if (status.logs.length > 0) {
          lastLogId.current = status.logs[status.logs.length - 1].id;
          setLogs((current) => [...current, ...status.logs.map((entry) =>
            makeLog(Date.now() * 1000 + entry.id, entry.message, entry.stream === "stderr" ? "warning" : "info"),
          )].slice(-2000));
        }
      } catch { if (active) setStatusError("Recorder status unavailable. Check the backend connection."); }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 300);
    return () => { active = false; window.clearInterval(timer); };
  }, [onRecordingChange, mode]);

  useEffect(() => {
    const update = () => setSeconds(startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0);
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const toggle = async () => {
    setBusy(true);
    try {
      if (recording) {
        await stopRecorder();
        onRecordingChange(false);
      } else {
        const result = await startRecorder(recordingName, saveDirectory, mode);
        onRecordingChange(Boolean(result.recording));
        setActiveMode(mode);
        setStartedAt(result.startedAt ?? null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Recorder command failed";
      setLogs((current) => [...current, makeLog(Date.now(), message, "warning")]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header"><div><p className="eyebrow">Synchronized capture</p><h1>{mode === "hrsoc" ? "HRSoc Recorder" : "Record"}</h1><p>{mode === "hrsoc" ? "Record synchronized FLIR videos and control Pupil eye tracker recordings." : "Record all camera sources into a single timestamped session."}</p></div></header>
      {statusError && <p className="settings-error" role="alert">{statusError}</p>}
      {otherRecording && <p className="recorder-note">The {activeMode === "hrsoc" ? "HRSoc Recorder" : "Record"} tab is using the cameras. Stop that session before starting another.</p>}
      <section className={thisRecording ? "record-hero surface active" : "record-hero surface"}>
        <div className="recording-state"><span className="record-orb" /><div><span>{thisRecording ? ready ? "RECORDING" : "PREPARING / FINALIZING" : otherRecording ? "CAMERAS IN USE" : "READY TO RECORD"}</span><strong>{formatDuration(thisRecording ? seconds : 0)}</strong><small>{thisRecording && ready ? `${config?.cameras.length ?? 0} FLIR streams writing` : "Camera configuration is checked when recording starts"}</small></div></div>
        <button className={thisRecording ? "stop-button" : "record-button"} disabled={busy || otherRecording || (!recording && (!config || !recordingName.trim() || !saveDirectory.trim() || Boolean(statusError)))} onClick={toggle}>{thisRecording ? <CircleStop size={18} /> : <span className="button-record-dot" />}{busy ? "Please wait…" : thisRecording ? "Stop recording" : "Start recording"}</button>
      </section>
      <div className="two-column-layout record-layout">
        <section className="surface settings-card">
          <div className="section-title"><div className="title-icon"><Folder size={19} /></div><div><h2>Session settings</h2><p>Choose naming and capture preferences.</p></div></div>
          <div className="form-stack">
            <label>Session name<input value={recordingName} disabled={recording} onChange={(event) => setRecordingName(event.target.value)} /></label>
            <label>Save directory<input value={saveDirectory} disabled={recording} onChange={(event) => setSaveDirectory(event.target.value)} placeholder="Path on the recording server" /></label>
            <p className="recorder-note">Output: <code>{saveDirectory.replace(/\/$/, "")}/{recordingName}</code></p>
            {mode === "hrsoc" && <p className="recorder-note">FLIR videos and <code>frame_timestamps.json</code> are saved here. Eye tracker recordings use the same session name and are stored on each Pupil Capture computer.</p>}
          </div>
        </section>
        <section className="surface source-list">
          <div className="section-title"><div className="title-icon"><Video size={19} /></div><div><h2>Sources</h2><p>{config?.cameras.length ?? 0} cameras configured</p></div></div>
          {config?.cameras.map((camera) => <div className="source-row" key={camera.serial}><span className="source-check"><span /></span><div><strong>Camera {camera.serial}</strong><small>{config.width} × {config.height} · {config.fps} FPS</small></div><span className="source-ready">Configured</span></div>)}
          <div className="storage"><HardDrive size={17} /><div><span>Storage location</span><strong>{saveDirectory || "Loading…"}</strong></div></div>
        </section>
      </div>
      {mode === "hrsoc" && <EyeTrackerStatusPanel />}
      <LogPanel title={mode === "hrsoc" ? "HRSoc recorder output" : "Recorder output"} logs={logs} onClear={() => setLogs([])} />
    </div>
  );
}
