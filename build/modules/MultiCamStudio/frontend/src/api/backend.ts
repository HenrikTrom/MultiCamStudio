export type Camera = {
  id: string;
  name: string;
  source: string;
  resolution: string;
  fps: number;
  codec: string;
  width: number;
  height: number;
};

export type LogEntry = {
  id: number;
  time: string;
  level: "info" | "success" | "warning";
  message: string;
};

const recordings = ["19037266", "19246521", "19338645", "19421325", "20174578"];

export const cameras: Camera[] = recordings.map((id, index) => ({
  id,
  name: `Camera ${String(index + 1).padStart(2, "0")}`,
  source: `/api/cameras/${index}/stream`,
  resolution: "1024 × 768",
  fps: 20,
  codec: "avc1.64002A",
  width: 1024,
  height: 768,
}));

type CameraResponse = {
  cameras: Array<{
    id: string;
    name: string;
    stream: string;
    codec: string;
    width: number;
    height: number;
    fps: number;
  }>;
};

export async function loadCameras(): Promise<Camera[]> {
  const response = await fetch("/api/cameras");
  if (!response.ok) throw new Error(`Camera service returned HTTP ${response.status}`);
  const payload = (await response.json()) as CameraResponse;
  return payload.cameras.map((camera) => ({
    id: camera.id,
    name: camera.name,
    source: camera.stream,
    resolution: `${camera.width} × ${camera.height}`,
    fps: camera.fps,
    codec: camera.codec,
    width: camera.width,
    height: camera.height,
  }));
}

async function changeCameraStream(action: "start" | "stop") {
  const response = await fetch(`/local-api/camera-stream/${action}`, { method: "POST" });
  const payload = await response.json() as { streaming?: boolean; error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Could not ${action} camera streamer`);
  return Boolean(payload.streaming);
}

export const startCameraStream = () => changeCameraStream("start");
export const stopCameraStream = () => changeCameraStream("stop");

export type ProcessLogLine = {
  id: number;
  stream: "stdout" | "stderr";
  message: string;
};

export async function getCameraStreamStatus(after = 0) {
  const response = await fetch(`/local-api/camera-stream/status?after=${after}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Camera stream status returned HTTP ${response.status}`);
  return response.json() as Promise<{ streaming: boolean; logs: ProcessLogLine[] }>;
}

export async function getRecorderStatus(after = 0) {
  const response = await fetch(`/local-api/recorder/status?after=${after}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Recorder status returned HTTP ${response.status}`);
  return response.json() as Promise<{
    recording: boolean;
    startedAt: number | null;
    logs: ProcessLogLine[];
  }>;
}

async function changeRecorder(action: "start" | "stop", name?: string) {
  const response = await fetch(`/local-api/recorder/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const payload = await response.json() as { recording?: boolean; startedAt?: number | null; error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Could not ${action} recorder`);
  return payload;
}

export const startRecorder = (name: string) => changeRecorder("start", name);
export const stopRecorder = () => changeRecorder("stop");

export type CalibrationResult = {
  success: boolean;
  exitCode?: number | null;
  resultAvailable: boolean;
};

type CalibrationStreamEvent =
  | { type: "log"; stream: "stdout" | "stderr"; message: string }
  | { type: "stage"; stage: CalibrationStage; state: CalibrationStageState }
  | ({ type: "complete" } & CalibrationResult);

export type CalibrationStage = "capture" | "calibrate" | "validate";
export type CalibrationStageState = "pending" | "running" | "success" | "error";

async function runCalibrationProcess(
  endpoint: string,
  onLog: (message: string, stream: "stdout" | "stderr") => void,
  onStage: (stage: CalibrationStage, state: CalibrationStageState) => void,
): Promise<CalibrationResult> {
  const response = await fetch(endpoint, { method: "POST" });
  if (!response.ok || !response.body) {
    throw new Error(`Calibration service returned HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let result: CalibrationResult | undefined;

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as CalibrationStreamEvent;
    if (event.type === "log") onLog(event.message, event.stream);
    else if (event.type === "stage") onStage(event.stage, event.state);
    else result = event;
  };

  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    lines.forEach(handleLine);
    if (done) break;
  }
  if (pending) handleLine(pending);
  if (!result) throw new Error("Calibration process ended without a completion status");
  return result;
}

export function runCalibration(
  onLog: (message: string, stream: "stdout" | "stderr") => void,
  onStage: (stage: CalibrationStage, state: CalibrationStageState) => void,
) {
  return runCalibrationProcess("/local-api/calibration/run", onLog, onStage);
}

export function runValidation(
  onLog: (message: string, stream: "stdout" | "stderr") => void,
  onStage: (stage: CalibrationStage, state: CalibrationStageState) => void,
) {
  return runCalibrationProcess("/local-api/calibration/validate", onLog, onStage);
}

export const calibrationResultUrl = "/local-api/calibration/result";
export const calibrationGuideUrl = "/local-api/calibration/guide";
export const latestCalibrationJsonUrl = "/local-api/calibration/latest-json";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type SettingsDocuments = {
  calibration: JsonValue;
  camera: JsonValue;
};

type SettingsError = { error?: string; details?: string[] };

export async function loadSettings(): Promise<SettingsDocuments> {
  const response = await fetch("/local-api/settings");
  const payload = await response.json() as SettingsDocuments & SettingsError;
  if (!response.ok) throw new Error(payload.error ?? `Settings service returned HTTP ${response.status}`);
  return payload;
}

export async function saveSettings(settings: SettingsDocuments): Promise<void> {
  const response = await fetch("/local-api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  const payload = await response.json() as SettingsError;
  if (!response.ok) {
    const details = payload.details?.length ? `\n${payload.details.join("\n")}` : "";
    throw new Error(`${payload.error ?? `Settings service returned HTTP ${response.status}`}${details}`);
  }
}

export const now = () =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());

export const makeLog = (
  id: number,
  message: string,
  level: LogEntry["level"] = "info",
): LogEntry => ({ id, message, level, time: now() });
