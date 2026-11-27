import { useEffect, useRef, useState } from "react";
import { Camera, CircleStop, Folder, HardDrive, ListChecks } from "lucide-react";
import { getRecorderConfig, getRecorderStatus, makeLog, recordFrame, startRecorder, stopRecorder, type LogEntry } from "../api/backend";
import LogPanel from "./LogPanel";

const duration = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
export default function RecordPage({ recording, onRecordingChange }: {
  recording: boolean; onRecordingChange: (value: boolean) => void;
}) {
  const [config, setConfig] = useState<Awaited<ReturnType<typeof getRecorderConfig>> | null>(null);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getRecorderStatus>> | null>(null);
  const [directory, setDirectory] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [frameBusy, setFrameBusy] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const after = useRef(0);
  const initialized = useRef(false);
  const known = useRef(new Set<string>());
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
          setSelected(new Set(next.recording && next.session ? next.session.topics : sources.topics.filter((topic) => topic.camera).map((topic) => topic.name)));
          initialized.current = true;
        } else {
          const defaults = sources.topics.filter((topic) => topic.camera && !known.current.has(topic.name));
          if (defaults.length) setSelected((old) => new Set([...old, ...defaults.map((topic) => topic.name)]));
        }
        sources.topics.forEach((topic) => known.current.add(topic.name));
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
      if (recording) { await stopRecorder(); onRecordingChange(false); }
      else { await startRecorder(directory, [...selected]); onRecordingChange(true); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Recording command failed"); }
    finally { setBusy(false); }
  };
  const capture = async () => {
    setFrameBusy(true); setError("");
    try {
      const result = await recordFrame(directory);
      setStatus((old) => old ? { ...old, frameSession: result } : old);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Frame capture failed"); }
    finally { setFrameBusy(false); }
  };
  const topics = [...(config?.topics ?? [])];
  for (const name of selected) if (!topics.some((topic) => topic.name === name)) topics.push({ name, types: [], camera: false, available: false });
  const capturing = frameBusy || status?.frameCapturing;
  const locked = busy || recording;
  const calibrationRunning = Boolean(status?.calibrationRunning);
  return <div className="page">
    <header className="page-header"><div><p className="eyebrow">ROS data capture</p><h1>Record</h1>
      <p>Record selected topics in a ROS bag, or save one synchronized camera frame set.</p></div></header>
    {(error || connectionError || status?.error || status?.frameError) && <p className="settings-error" role="alert">{error || connectionError || status?.error || status?.frameError}</p>}
    {calibrationRunning && <p className="recorder-note">Finish or cancel calibration before recording.</p>}
    <section className={recording ? "record-hero surface active" : "record-hero surface"}>
      <div className="recording-state"><span className="record-orb" /><div>
        <span>{recording ? status?.ready ? "RECORDING ROS BAG" : "PREPARING / FINALIZING" : "READY TO RECORD"}</span>
        <strong>{duration(seconds)}</strong><small>{status?.progress?.message_count !== undefined ? `${status.progress.message_count} messages saved` :
          status?.progress?.bytes_written !== undefined ? `${(status.progress.bytes_written / 1048576).toFixed(1)} MiB written` : "Selected topics are recorded at their published rates"}</small>
      </div></div>
      <div className="record-actions">
        <button className="secondary-button" disabled={Boolean(capturing) || calibrationRunning || !config || !directory.trim()} onClick={capture}>
          <Camera size={18} />{capturing ? "Capturing frame…" : "Record frame"}
        </button>
        <button className={recording ? "stop-button" : "record-button"}
          disabled={busy || calibrationRunning || (!recording && (!config || !selected.size || !directory.trim()))} onClick={toggle}>
          {recording ? <CircleStop size={18} /> : <span className="button-record-dot" />}
          {busy ? "Please wait…" : recording ? "Stop recording" : "Start ROS bag"}
        </button>
      </div>
    </section>
    <div className="two-column-layout record-layout">
      <section className="surface settings-card">
        <div className="section-title"><div className="title-icon"><Folder size={19} /></div><div><h2>Storage</h2><p>Timestamped folders in {config?.timeZone ?? "local time"}.</p></div></div>
        <div className="form-stack">
          <label>Recordings directory<input value={directory} disabled={locked || Boolean(capturing)} onChange={(event) => setDirectory(event.target.value)} /></label>
          <p className="recorder-note">ROS bag: <code>{directory}/{config?.timestamp ?? "YYYY-MM-DD-HH-mm-ss"}</code></p>
          <p className="recorder-note">PNG frame: <code>{directory}/frame_{config?.timestamp ?? "YYYY-MM-DD-HH-mm-ss"}</code></p>
          <p className="recorder-note">Record frame saves one lossless PNG for every configured camera. Frames must match within {config?.syncToleranceMs ?? 5} ms. It can run while a ROS bag is recording.</p>
          {status?.session && <p className="recorder-note">Latest ROS bag: <code>{status.session.outputDirectory}</code></p>}
          {status?.frameSession && <p className="recorder-note">Latest frame: <code>{status.frameSession.outputDirectory}</code></p>}
        </div>
        <div className="storage"><HardDrive size={17} /><div><span>Storage location</span><strong>{directory || "Loading…"}</strong></div></div>
      </section>
      <section className="surface source-list">
        <div className="section-title"><div className="title-icon"><ListChecks size={19} /></div><div><h2>Topics to record</h2><p>{selected.size} selected · Camera topics are selected by default</p></div></div>
        {config?.topicsError && <p className="recorder-note">Topic discovery is unavailable. Configured camera topics remain available.</p>}
        <label className="topic-filter">Filter topics<input value={filter} placeholder="Search topic names" onChange={(event) => setFilter(event.target.value)} /></label>
        <div className="topic-menu-actions">
          <button className="secondary-button" disabled={locked} onClick={() => setSelected(new Set(topics.map((topic) => topic.name)))}>Select all</button>
          <button className="secondary-button" disabled={locked} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
        <div className="topic-checklist" role="group" aria-label="ROS topics to record">
          {topics.filter((topic) => topic.name.toLowerCase().includes(filter.toLowerCase())).map((topic) => <label className="topic-option" key={topic.name}>
            <input type="checkbox" checked={selected.has(topic.name)} disabled={locked} onChange={(event) => {
              const checked = event.target.checked;
              setSelected((old) => { const next = new Set(old); if (checked) next.add(topic.name); else next.delete(topic.name); return next; });
            }} />
            <span><strong>{topic.name}</strong><small>{topic.types.join(", ") || "Type unavailable"}{!topic.available ? " · Not currently discovered" : ""}</small></span>
            {topic.camera && <small className="topic-camera-badge">Camera</small>}
          </label>)}
          {!topics.length && <p className="recorder-note">Discovering ROS topics…</p>}
        </div>
      </section>
    </div>
    <LogPanel title="Recorder output" logs={logs} onClear={() => setLogs([])} />
  </div>;
}
