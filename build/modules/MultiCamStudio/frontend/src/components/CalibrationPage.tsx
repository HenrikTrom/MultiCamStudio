import { useEffect, useState } from "react";
import { Box, Check, ChevronRight, CircleX, Copy, Film, Image, LoaderCircle, Play, ScanLine } from "lucide-react";
import { calibrationGuideUrl, calibrationResultUrl, latestCalibrationJsonUrl, makeLog, runCalibration, runValidation, type CalibrationStage, type CalibrationStageState, type LogEntry } from "../api/backend";
import LogPanel from "./LogPanel";
import Calibration3DDialog from "./Calibration3DDialog";

const stageDefinitions: Array<{ id: CalibrationStage; number: string; label: string }> = [
  { id: "capture", number: "01", label: "Capture" },
  { id: "calibrate", number: "02", label: "Calibrate" },
  { id: "validate", number: "03", label: "Validate" },
];

const initialStageStates: Record<CalibrationStage, CalibrationStageState> = {
  capture: "pending",
  calibrate: "pending",
  validate: "pending",
};

export default function CalibrationPage() {
  const [busy, setBusy] = useState(false);
  const [validated, setValidated] = useState(false);
  const [guideExpanded, setGuideExpanded] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [resultVersion, setResultVersion] = useState(0);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [show3DView, setShow3DView] = useState(false);
  const [stageStates, setStageStates] = useState(initialStageStates);
  const [logs, setLogs] = useState<LogEntry[]>([
    makeLog(1, "Calibration workspace ready"),
    makeLog(2, "Ready to run the multi-camera calibration script"),
  ]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${calibrationResultUrl}?v=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) return;
      await response.blob();
      setResultVersion(Date.now());
      setValidated(true);
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  const run = async () => {
    let nextLogId = Date.now();
    setBusy(true);
    setValidated(false);
    setGuideExpanded(false);
    setPreviewExpanded(false);
    setCopyStatus("idle");
    setStageStates({ ...initialStageStates });
    setLogs([makeLog(nextLogId++, "Starting capture → calibrate → validate pipeline")]);
    try {
      const result = await runCalibration((message, stream) => {
        const entry = makeLog(nextLogId++, message, stream === "stderr" ? "warning" : "info");
        setLogs((old) => [...old, entry]);
      }, (stage, state) => {
        setStageStates((old) => ({ ...old, [stage]: state }));
      });
      if (result.success && result.resultAvailable) {
        setLogs((old) => [...old, makeLog(nextLogId++, "Calibration completed successfully", "success")]);
        setResultVersion(Date.now());
        setValidated(true);
      } else if (result.success) {
        setLogs((old) => [...old, makeLog(nextLogId++, "Calibration succeeded, but back_projeced3d.jpg was not found", "warning")]);
      } else {
        setLogs((old) => [...old, makeLog(nextLogId++, `Calibration failed with exit code ${result.exitCode ?? "unknown"}`, "warning")]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown calibration error";
      setLogs((old) => [...old, makeLog(nextLogId++, message, "warning")]);
    } finally {
      setBusy(false);
    }
  };

  const copyCalibration = async () => {
    try {
      const response = await fetch(latestCalibrationJsonUrl);
      if (!response.ok) throw new Error(`Calibration JSON request failed with HTTP ${response.status}`);
      await navigator.clipboard.writeText(await response.text());
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  };

  const quickValidation = async () => {
    let nextLogId = Date.now();
    setBusy(true);
    setCopyStatus("idle");
    setStageStates({ ...initialStageStates });
    setLogs([makeLog(nextLogId++, "Starting quick validation")]);
    try {
      const result = await runValidation((message, stream) => {
        setLogs((old) => [...old, makeLog(nextLogId++, message, stream === "stderr" ? "warning" : "info")]);
      }, (stage, state) => {
        setStageStates((old) => ({ ...old, [stage]: state }));
      });
      if (result.success && result.resultAvailable) {
        setLogs((old) => [...old, makeLog(nextLogId++, "Validation completed successfully", "success")]);
        setResultVersion(Date.now());
        setValidated(true);
      } else if (result.success) {
        setLogs((old) => [...old, makeLog(nextLogId++, "Validation succeeded, but back_projeced3d.jpg was not found", "warning")]);
      } else {
        setLogs((old) => [...old, makeLog(nextLogId++, `Validation failed with exit code ${result.exitCode ?? "unknown"}`, "warning")]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown validation error";
      setLogs((old) => [...old, makeLog(nextLogId++, message, "warning")]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header"><div><p className="eyebrow">Lens alignment</p><h1>Calibration</h1><p>Capture a dataset, solve camera parameters, and validate the result.</p></div></header>
      <section className="step-strip surface">
        {stageDefinitions.map((stage, index) => {
          const state = stageStates[stage.id];
          return (
            <div className="step" key={stage.id}>
              <span className={`step-number ${state}`}>
                {state === "running" ? <LoaderCircle className="stage-spinner" size={15} /> : state === "success" ? <Check size={15} /> : state === "error" ? <CircleX size={15} /> : stage.number}
              </span>
              <div><strong>{stage.label}</strong><small>{state.charAt(0).toUpperCase() + state.slice(1)}</small></div>
              {index < stageDefinitions.length - 1 && <ChevronRight size={17} />}
            </div>
          );
        })}
        <div className="quick-validation-action">
          <button className="secondary-button" type="button" disabled={busy} onClick={quickValidation}>Quick validation</button>
          <small>Click here if you just want to validate the latest calibration without recording new images.</small>
        </div>
      </section>
      <div className="two-column-layout">
        <section className="surface settings-card">
          <div className="section-title"><div className="title-icon"><Film size={19} /></div><div><h2>Calibration guide</h2><p>Move the board so that all markers are visiable in each camera.</p></div></div>
          <button
            type="button"
            className={`gif-placeholder expandable${guideExpanded ? " fullscreen" : ""}`}
            onClick={() => setGuideExpanded((expanded) => !expanded)}
            aria-label={guideExpanded ? "Close full-screen calibration guide" : "Open full-screen calibration guide"}
          >
            <img className="calibration-guide-gif" src={calibrationGuideUrl} alt="Four-camera calibration guide" />
          </button>
          <button className="primary-button full" disabled={busy} onClick={run}><Play size={17} fill="currentColor" />{busy ? "Calibration running…" : "Run calibration"}</button>
        </section>
        <section className="surface preview-card">
          <div className="preview-title-row">
            <div className="section-title"><div className="title-icon"><Image size={19} /></div><div><h2>Validation preview</h2></div></div>
            <div className="preview-actions">
              <button className="secondary-button" type="button" onClick={() => setShow3DView(true)}><Box size={14} />3D view</button>
              <button className="secondary-button copy-calibration" type="button" onClick={copyCalibration}>
                {copyStatus === "copied" ? <Check size={14} /> : <Copy size={14} />}
                {copyStatus === "copied" ? "Copied" : copyStatus === "error" ? "Copy failed" : "Copy JSON"}
              </button>
            </div>
          </div>
          {validated ? (
            <button
              type="button"
              className={`validation-preview success expandable${previewExpanded ? " fullscreen" : ""}`}
              onClick={() => setPreviewExpanded((expanded) => !expanded)}
              aria-label={previewExpanded ? "Close full-screen calibration preview" : "Open full-screen calibration preview"}
            >
              <img className="calibration-result" src={`${calibrationResultUrl}?v=${resultVersion}`} alt="Back-projected 3D calibration result" />
            </button>
          ) : (
            <div className="validation-preview"><ScanLine size={42} /><strong>No calibration result</strong><span>The preview appears after a successful calibration.</span></div>
          )}
        </section>
      </div>
      <div className="calibration-log"><LogPanel title="Calibration output" logs={logs} onClear={() => setLogs([])} /></div>
      {show3DView && <Calibration3DDialog onClose={() => setShow3DView(false)} />}
    </div>
  );
}
