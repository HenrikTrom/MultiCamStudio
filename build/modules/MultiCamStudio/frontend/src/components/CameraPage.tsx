import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Columns2, Columns3, Focus as FocusIcon, Grid2X2, Maximize2, Minimize2, Play, RefreshCw, SlidersHorizontal, Square } from "lucide-react";
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

function CameraTile({ camera, focus, streaming }: { camera: Camera; focus: FocusPeakingSettings; streaming: boolean }) {
  const enabled = streaming && camera.online && camera.ready && !camera.error && !camera.imageError;
  const framePointer = useRef<{
    id: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  const dragged = useRef(false);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState("Connecting…");
  const [expanded, setExpanded] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [histogram, setHistogram] = useState<HistogramData>(emptyHistogram);
  const handleStatus = useCallback((message: string, error = false) => {
    setStatus(message);
    setFailed(error);
  }, []);
  const handleHistogram = useCallback((value: HistogramData) => setHistogram(value), []);

  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);

  const toggleExpanded = () => {
    setExpanded((value) => !value);
    setPan({ x: 0, y: 0 });
  };

  const problem = camera.error || camera.imageError;
  const visibleStatus = !streaming ? "Preview stopped" : problem || (!camera.online ?
    camera.publisherCount ? "Waiting for images" : "Topic offline" : !camera.ready ? "Preparing preview…" : status);
  const live = enabled && camera.previewActive && !failed;
  const hz = (value: number) => `${value.toFixed(1)} Hz`;

  return (
    <article className="camera-tile" data-camera-id={camera.id}>
      <div
        className={expanded ? "camera-frame expanded" : "camera-frame"}
        role="button"
        tabIndex={0}
        aria-label={expanded ? `Drag to pan ${camera.name}; click or press Escape to close` : `Enlarge ${camera.name}`}
        style={{ "--pan-x": `${pan.x}px`, "--pan-y": `${pan.y}px` } as React.CSSProperties}
        onClick={() => {
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          toggleExpanded();
        }}
        onPointerDown={(event) => {
          if (!expanded || event.button !== 0) return;
          dragged.current = false;
          framePointer.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            panX: pan.x,
            panY: pan.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const pointer = framePointer.current;
          if (!pointer || pointer.id !== event.pointerId) return;
          const deltaX = event.clientX - pointer.x;
          const deltaY = event.clientY - pointer.y;
          if (Math.abs(deltaX) + Math.abs(deltaY) > 2) dragged.current = true;
          const bounds = event.currentTarget.getBoundingClientRect();
          setPan({
            x: Math.max(-bounds.width / 2, Math.min(bounds.width / 2, pointer.panX + deltaX)),
            y: Math.max(-bounds.height / 2, Math.min(bounds.height / 2, pointer.panY + deltaY)),
          });
        }}
        onPointerUp={(event) => {
          if (framePointer.current?.id === event.pointerId) framePointer.current = null;
        }}
        onPointerCancel={() => { framePointer.current = null; }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleExpanded();
          }
        }}
      >
        <CameraStream enabled={enabled} camera={camera} focus={focus} onStatus={handleStatus} onHistogram={handleHistogram} />
        {(!enabled || failed) && (
          <div className="signal-fallback">
            <RefreshCw size={25} />
            <span>{visibleStatus}</span>
            <small>{camera.topic}</small>
          </div>
        )}
        <div className={live ? "stream-badge" : "stream-badge offline"}><span />{live ? "LIVE" : camera.online && streaming ? "ONLINE" : "OFFLINE"}</div>
        <span className="icon-overlay" aria-hidden="true">{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</span>
      </div>
      <div className="camera-histogram"><div><strong>Histogram</strong><span className="histogram-legend"><i className="luma" />Y<i className="red" />R<i className="green" />G<i className="blue" />B</span></div><Histogram data={histogram} /></div>
      <footer>
        <div><strong>{camera.name}</strong><span>{camera.id} · {visibleStatus}</span></div>
        <div className="camera-meta"><span>{camera.resolution}</span></div>
      </footer>
      <div className="topic-details">
        <code title={camera.topic}>{camera.topic}</code>
        <div><span>Input <strong>{hz(camera.inputFps)}</strong></span>
          <span>Preview <strong>{hz(camera.streamFps)}</strong></span>
          <span>{camera.publisherCount} publisher{camera.publisherCount === 1 ? "" : "s"}</span></div>
      </div>
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
  const wasStreaming = useRef(false);
  const [serviceError, setServiceError] = useState("");
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
    let active = true;
    let timer: number;
    const poll = async () => {
      try {
        const status = await getCameraStreamStatus(lastStreamerLogId.current);
        const discovered = status.streaming ? await loadCameras() : null;
        if (!active) return;
        setStreaming(status.streaming);
        setServiceError("");
        if (status.streaming && !wasStreaming.current) setStreamGeneration((value) => value + 1);
        wasStreaming.current = status.streaming;
        if (discovered) setStreamCameras(discovered);
        else setStreamCameras((current) => current.map((camera) => ({ ...camera,
          online: false, previewActive: false, inputFps: 0, streamFps: 0, publisherCount: 0 })));
        if (status.logs.length > 0) {
          lastStreamerLogId.current = status.logs[status.logs.length - 1].id;
          setLogs((current) => [...current, ...status.logs.map((entry) =>
            makeLog(Date.now() * 1000 + entry.id, entry.message, entry.stream === "stderr" ? "warning" : "info"),
          )].slice(-2000));
        }
      } catch (error) {
        if (active) {
          setStreaming(false);
          wasStreaming.current = false;
          setServiceError(error instanceof Error ? error.message : "Camera service unavailable");
        }
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
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

  const onlineCount = streaming ? streamCameras.filter((camera) => camera.online).length : 0;
  const previewCount = streaming ? streamCameras.filter((camera) => camera.previewActive).length : 0;

  return (
    <div className="page">
      <header className="page-header">
        <div><p className="eyebrow">Live workspace</p><h1>Streamer</h1><p>Monitor ROS camera images and measured stream frequencies.</p></div>
        <div className="header-status"><span className={onlineCount > 0 ? "status-pulse" : "status-pulse offline"} /><div><strong>{streaming ? `${onlineCount} / ${streamCameras.length} topics online` : `${streamCameras.length} configured topics`}</strong><small>{streaming ? `${previewCount} previews active · 30 Hz limit` : "Preview service stopped"}</small></div></div>
      </header>

      {serviceError && <p className="service-error" role="alert">{serviceError}. Retrying automatically…</p>}
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

      <p className="stream-explanation">{streaming ? `${onlineCount} of ${streamCameras.length} configured topics are delivering images. Frequencies are measured over 2 seconds; a topic is offline after 2 seconds without an image.` : "Preview monitoring is stopped. Start the stream to check topic activity and view images."}</p>
      <section className="camera-grid" style={{ "--columns": columns } as React.CSSProperties}>
        {streamCameras.map((camera) => <CameraTile camera={camera} focus={focus} streaming={streaming} key={`${camera.id}-${streamGeneration}`} />)}
      </section>
      {streamCameras.length === 0 && <section className="surface pending-feature"><p>{streaming ? "Loading configured topics…" : "Start the preview service to load your configured camera topics."}</p></section>}
      <LogPanel title="Camera service" logs={logs} onClear={() => setLogs([])} />
    </div>
  );
}
