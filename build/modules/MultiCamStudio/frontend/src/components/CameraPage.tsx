import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Columns2, Columns3, Focus as FocusIcon, Grid2X2, Maximize2, Play, RefreshCw, SlidersHorizontal, Square } from "lucide-react";
import { getCameraStreamStatus, loadCameras, makeLog, startCameraStream, stopCameraStream, type Camera, type LogEntry } from "../api/backend";
import CameraStream, { type FocusPeakingSettings, type HistogramData } from "./CameraStream";
import LogPanel from "./LogPanel";

const emptyHistogram = (): HistogramData => ({
  red: Array(256).fill(0),
  green: Array(256).fill(0),
  blue: Array(256).fill(0),
  luminance: Array(256).fill(0),
});

function Histogram({ data }: { data: HistogramData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#111814";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.globalAlpha = 0.5;
    const draw = (values: number[], color: string) => {
      const binWidth = canvas.width / values.length;
      context.fillStyle = color;
      values.forEach((value, index) => {
        const height = value * (canvas.height - 6);
        context.fillRect(index * binWidth, canvas.height - 3 - height, binWidth, height);
      });
    };
    draw(data.luminance, "#e5ebe7");
    draw(data.red, "#ef6660");
    draw(data.green, "#5fc681");
    draw(data.blue, "#6295e7");
    context.restore();
  }, [data]);
  return <canvas ref={canvasRef} width={512} height={72} aria-label="256-bin RGB and luminance histogram" />;
}

function CameraTile({ camera, focus }: { camera: Camera; focus: FocusPeakingSettings }) {
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState("Connecting…");
  const [expanded, setExpanded] = useState(false);
  const [histogram, setHistogram] = useState<HistogramData>(emptyHistogram);
  const handleStatus = useCallback((message: string, error = false) => {
    setStatus(message);
    setFailed(error);
  }, []);
  const handleHistogram = useCallback((value: HistogramData) => setHistogram(value), []);

  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);

  return (
    <article className="camera-tile">
      <div className={expanded ? "camera-frame expanded" : "camera-frame"} onClick={() => setExpanded((value) => !value)}>
        <CameraStream camera={camera} focus={focus} onStatus={handleStatus} onHistogram={handleHistogram} />
        {failed && (
          <div className="signal-fallback">
            <RefreshCw size={25} />
            <span>{status}</span>
            <small>Check the streamer on port 8080</small>
          </div>
        )}
        <div className="stream-badge"><span /> LIVE</div>
        <button type="button" className="icon-overlay" aria-label={expanded ? `Close ${camera.name}` : `Expand ${camera.name}`}><Maximize2 size={16} /></button>
      </div>
      <div className="camera-histogram"><div><strong>Histogram</strong><span className="histogram-legend"><i className="luma" />Y<i className="red" />R<i className="green" />G<i className="blue" />B</span></div><Histogram data={histogram} /></div>
      <footer>
        <div><strong>{camera.name}</strong><span>{camera.id} · {status}</span></div>
        <div className="camera-meta"><span>{camera.resolution}</span><span>{camera.fps} FPS</span></div>
      </footer>
    </article>
  );
}

export default function CameraPage() {
  const [columns, setColumns] = useState(3);
  const [streamCameras, setStreamCameras] = useState<Camera[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamBusy, setStreamBusy] = useState(false);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const lastStreamerLogId = useRef(0);
  const [focus, setFocus] = useState<FocusPeakingSettings>({
    enabled: true,
    threshold: 0.14,
    softness: 0.05,
    opacity: 0.85,
    radius: 1,
    maxFps: 30,
    color: "#ff1818",
  });
  const [logs, setLogs] = useState<LogEntry[]>([
    makeLog(1, "Camera service initialized", "success"),
    makeLog(2, "Discovering video sources…"),
  ]);
  const options = useMemo(() => [
    { value: 1, icon: Columns2, label: "1 column" },
    { value: 2, icon: Grid2X2, label: "2 columns" },
    { value: 3, icon: Columns3, label: "3 columns" },
  ], []);

  useEffect(() => {
    void loadCameras()
      .then((discovered) => {
        setStreamCameras(discovered);
        setStreaming(true);
        setLogs((value) => [...value, makeLog(Date.now(), `${discovered.length} camera streams discovered`, "success")]);
      })
      .catch((error: unknown) => {
        setStreaming(false);
        const message = error instanceof Error ? error.message : "Unknown camera-service error";
        setLogs((value) => [...value, makeLog(Date.now(), `Camera discovery failed: ${message}`, "warning")]);
      });
  }, []);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const status = await getCameraStreamStatus(lastStreamerLogId.current);
        if (!active) return;
        setStreaming(status.streaming);
        if (status.logs.length > 0) {
          lastStreamerLogId.current = status.logs[status.logs.length - 1].id;
          setLogs((current) => [...current, ...status.logs.map((entry) =>
            makeLog(Date.now() * 1000 + entry.id, entry.message, entry.stream === "stderr" ? "warning" : "info"),
          )]);
        }
      } catch { /* retain the last known state */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 400);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const startStream = async () => {
    setStreamBusy(true);
    try {
      await startCameraStream();
      const discovered = await loadCameras();
      setStreamCameras(discovered);
      setStreamGeneration((value) => value + 1);
      setStreaming(true);
      setLogs((value) => [...value, makeLog(Date.now(), "Camera streamer started", "success")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start camera streamer";
      setLogs((value) => [...value, makeLog(Date.now(), message, "warning")]);
    } finally {
      setStreamBusy(false);
    }
  };

  const stopStream = async () => {
    setStreamBusy(true);
    try {
      await stopCameraStream();
      setStreaming(false);
      setLogs((value) => [...value, makeLog(Date.now(), "Camera streamer stopped", "success")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not stop camera streamer";
      setLogs((value) => [...value, makeLog(Date.now(), message, "warning")]);
    } finally {
      setStreamBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div><p className="eyebrow">Live workspace</p><h1>Camera check</h1><p>Monitor and verify all connected camera feeds.</p></div>
        <div className="header-status"><span className={streaming ? "status-pulse" : "status-pulse offline"} /><div><strong>{streaming ? streamCameras.length : 0} online</strong><small>{streaming ? "Streams healthy" : "Streamer stopped"}</small></div></div>
      </header>

      <section className="toolbar surface">
        <div className="toolbar-group"><SlidersHorizontal size={17} /><span>Grid layout</span>
          <div className="segmented">
            {options.map(({ value, icon: Icon, label }) => (
              <button className={columns === value ? "selected" : ""} onClick={() => setColumns(value)} key={value} aria-label={label} title={label}>
                <Icon size={16} /> <span>{value}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="stream-controls">
          <button className="secondary-button" type="button" disabled={streamBusy || streaming} onClick={startStream}><Play size={14} />Start stream</button>
          <button className="secondary-button" type="button" disabled={streamBusy || !streaming} onClick={stopStream}><Square size={13} fill="currentColor" />Stop stream</button>
        </div>
      </section>

      <section className="focus-toolbar surface" aria-label="Focus peaking controls">
        <div className="focus-heading"><FocusIcon size={17} /><strong>Focus peaking</strong><label className="focus-toggle"><input type="checkbox" checked={focus.enabled} onChange={(event) => setFocus((value) => ({ ...value, enabled: event.target.checked }))} /><span>{focus.enabled ? "On" : "Off"}</span></label></div>
        <label>Threshold<input type="range" min="0.02" max="0.40" step="0.01" value={focus.threshold} onChange={(event) => setFocus((value) => ({ ...value, threshold: Number(event.target.value) }))} /><output>{focus.threshold.toFixed(2)}</output></label>
        <label>Softness<input type="range" min="0.01" max="0.20" step="0.01" value={focus.softness} onChange={(event) => setFocus((value) => ({ ...value, softness: Number(event.target.value) }))} /><output>{focus.softness.toFixed(2)}</output></label>
        <label>Opacity<input type="range" min="0.10" max="1" step="0.05" value={focus.opacity} onChange={(event) => setFocus((value) => ({ ...value, opacity: Number(event.target.value) }))} /><output>{focus.opacity.toFixed(2)}</output></label>
        <label>Radius<input type="range" min="1" max="4" step="0.5" value={focus.radius} onChange={(event) => setFocus((value) => ({ ...value, radius: Number(event.target.value) }))} /><output>{focus.radius.toFixed(1)}</output></label>
        <label>Max FPS<input type="range" min="5" max="60" step="5" value={focus.maxFps} onChange={(event) => setFocus((value) => ({ ...value, maxFps: Number(event.target.value) }))} /><output>{focus.maxFps}</output></label>
        <label className="focus-color">Color<input type="color" value={focus.color} onChange={(event) => setFocus((value) => ({ ...value, color: event.target.value }))} /></label>
      </section>

      <section className="camera-grid" style={{ "--columns": columns } as React.CSSProperties}>
        {streamCameras.map((camera) => <CameraTile camera={camera} focus={focus} key={`${camera.id}-${streamGeneration}`} />)}
      </section>
      <LogPanel title="Camera service" logs={logs} onClear={() => setLogs([])} />
    </div>
  );
}
