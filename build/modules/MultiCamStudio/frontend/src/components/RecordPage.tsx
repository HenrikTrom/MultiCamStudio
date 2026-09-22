import { useEffect, useRef, useState } from "react";
import { CircleStop, Folder, HardDrive, Video } from "lucide-react";
import { cameras, getRecorderStatus, makeLog, startRecorder, stopRecorder, type LogEntry } from "../api/backend";
import LogPanel from "./LogPanel";

const formatDuration = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
const timestampName = () => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
};

export default function RecordPage({
  recording,
  onRecordingChange,
}: {
  recording: boolean;
  onRecordingChange: (recording: boolean) => void;
}) {
  const [seconds, setSeconds] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [recordingName, setRecordingName] = useState(timestampName);
  const lastLogId = useRef(0);
  const [logs, setLogs] = useState<LogEntry[]>([makeLog(1, "Recorder ready · 5 sources armed", "success")]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const status = await getRecorderStatus(lastLogId.current);
        if (!active) return;
        onRecordingChange(status.recording);
        setStartedAt(status.startedAt);
        if (status.logs.length > 0) {
          lastLogId.current = status.logs[status.logs.length - 1].id;
          setLogs((current) => [...current, ...status.logs.map((entry) =>
            makeLog(Date.now() * 1000 + entry.id, entry.message, entry.stream === "stderr" ? "warning" : "info"),
          )]);
        }
      } catch { /* keep showing the last recorder state */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 300);
    return () => { active = false; window.clearInterval(timer); };
  }, [onRecordingChange]);

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
        const result = await startRecorder(recordingName);
        onRecordingChange(Boolean(result.recording));
        setStartedAt(result.startedAt ?? Date.now());
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
      <header className="page-header"><div><p className="eyebrow">Synchronized capture</p><h1>Record</h1><p>Record all camera sources into a single timestamped session.</p></div></header>
      <section className={recording ? "record-hero surface active" : "record-hero surface"}>
        <div className="recording-state"><span className="record-orb" /><div><span>{recording ? "RECORDING" : "READY TO RECORD"}</span><strong>{formatDuration(seconds)}</strong><small>{recording ? "5 streams writing" : "All streams are armed"}</small></div></div>
        <button className={recording ? "stop-button" : "record-button"} disabled={busy} onClick={toggle}>{recording ? <CircleStop size={18} /> : <span className="button-record-dot" />}{busy ? "Please wait…" : recording ? "Stop recording" : "Start recording"}</button>
      </section>
      <div className="two-column-layout record-layout">
        <section className="surface settings-card">
          <div className="section-title"><div className="title-icon"><Folder size={19} /></div><div><h2>Session settings</h2><p>Choose naming and capture preferences.</p></div></div>
          <div className="form-stack">
            <label>Session name<input value={recordingName} disabled={recording} onChange={(event) => setRecordingName(event.target.value)} /></label>
          </div>
        </section>
        <section className="surface source-list">
          <div className="section-title"><div className="title-icon"><Video size={19} /></div><div><h2>Sources</h2><p>{cameras.length} cameras selected</p></div></div>
          {cameras.map((camera) => <div className="source-row" key={camera.id}><span className="source-check"><span /></span><div><strong>{camera.name}</strong><small>{camera.resolution} · {camera.fps} FPS</small></div><span className="source-ready">Ready</span></div>)}
          <div className="storage"><HardDrive size={17} /><div><span>Estimated storage</span><strong>1.8 GB / minute</strong></div></div>
        </section>
      </div>
      <LogPanel title="Recorder output" logs={logs} onClear={() => setLogs([])} />
    </div>
  );
}
