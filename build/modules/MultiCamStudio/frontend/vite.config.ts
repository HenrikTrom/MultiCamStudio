import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import Ajv, { type ErrorObject } from "ajv";
import { spawn } from "node:child_process";
import { createReadStream, stat } from "node:fs";
import { readFile, readdir, rename, stat as statAsync, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";

const calibrationStages = [
  { id: "capture", label: "Capture", script: "/opt/modules/MultiCamStudio/backend/scripts/record.sh" },
  { id: "calibrate", label: "Calibrate", script: "/opt/modules/MultiCamStudio/backend/scripts/calibrate.sh" },
  { id: "validate", label: "Validate", script: "/opt/modules/MultiCamStudio/backend/scripts/validate.sh" },
] as const;
const calibrationResult =
  "/home/docker/workspace/data/test/back_projeced3d.jpg";
const calibrationGuide =
  "/opt/modules/MultiCamStudio/content/result.gif";
const calibrationLogsDirectory =
  "/home/docker/workspace/data/logs";
const cameraStreamerExecutable = process.env.FLIR_STREAMER_EXECUTABLE ??
  "/opt/modules/MultiCamStudio/backend/build/fast_flir_web_streamer";
const recorderExecutable = process.env.FLIR_RECORDER_EXECUTABLE ??
  "/opt/modules/MultiCamStudio/backend/build/flir_recorder";
const eyeRecorderExecutable = process.env.FLIR_EYE_RECORDER_EXECUTABLE ??
  "/opt/modules/MultiCamStudio/backend/build/flir-eye-tracker-record/flir_eye_tracker_recorder";
const eyeTrackerSettingsFile = process.env.EYE_TRACKER_SETTINGS_FILE ??
  "/home/docker/workspace/cfg/eye_tracker_settings.json";
type RecorderMode = "camera" | "hrsoc";
const cameraStreamerPort = 8080;
let cameraStreamerProcess: ReturnType<typeof spawn> | null = null;
let recorderProcess: ReturnType<typeof spawn> | null = null;
let recorderStartedAt: number | null = null;
let recorderMode: RecorderMode | null = null;
let recorderStarting = false;
let recorderReady = false;
let recorderStopping: Promise<void> | null = null;
let recorderSession: { name: string; saveDirectory: string } | null = null;
let calibrationRunning = false;
type ProcessLog = { id: number; stream: "stdout" | "stderr"; message: string };
let nextProcessLogId = 1;
let cameraStreamerLogs: ProcessLog[] = [];
let recorderLogs: ProcessLog[] = [];
const settingsDocuments = {
  camera: {
    file: process.env.CAMERA_SETTINGS_FILE ?? "/home/docker/workspace/cfg/camera_settings_1024x768.json",
    schema: "/opt/modules/flirmulticamera/cfg/CameraSettings.Schema.json",
  },
  calibration: {
    file: "/home/docker/workspace/cfg/CameraCalibrationSettings.json",
    schema: "/opt/modules/multi-camera-calib/cfg/CameraCalibrationSettings.schema.json",
  },
} as const;

function sendJson(response: ServerResponse, status: number, payload: object) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function readRequestJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 2_000_000) reject(new Error("Settings request is too large"));
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body is not valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function formatValidationErrors(document: string, errors: ErrorObject[] | null | undefined) {
  return (errors ?? []).map((error) =>
    `${document}${error.instancePath || "/"}: ${error.message ?? "is invalid"}`,
  );
}

async function atomicWriteJson(path: string, value: unknown) {
  const temporaryPath = `${path}.opencv-web-gui-${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function appendProcessLog(target: ProcessLog[], stream: "stdout" | "stderr", message: string) {
  if (!message) return;
  target.push({ id: nextProcessLogId++, stream, message });
  if (target.length > 2000) target.splice(0, target.length - 2000);
}

function captureProcessOutput(
  child: ReturnType<typeof spawn>,
  target: ProcessLog[],
  prefix: string,
) {
  let stdoutRemainder = "";
  let stderrRemainder = "";
  const ingest = (stream: "stdout" | "stderr", chunk: Buffer) => {
    const previous = stream === "stdout" ? stdoutRemainder : stderrRemainder;
    const lines = `${previous}${chunk.toString()}`.split(/\r\n|\r|\n/);
    const remainder = lines.pop() ?? "";
    if (stream === "stdout") stdoutRemainder = remainder;
    else stderrRemainder = remainder;
    lines.filter(Boolean).forEach((message) => appendProcessLog(target, stream, message));
    const destination = stream === "stdout" ? process.stdout : process.stderr;
    destination.write(`[${prefix}] ${chunk.toString()}`);
  };
  child.stdout?.on("data", (chunk: Buffer) => ingest("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => ingest("stderr", chunk));
  child.once("close", () => {
    appendProcessLog(target, "stdout", stdoutRemainder);
    appendProcessLog(target, "stderr", stderrRemainder);
  });
}

function callCameraStreamer(path: string, method: "GET" | "POST", timeout = 500) {
  return new Promise<boolean>((resolve) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: cameraStreamerPort,
      path,
      method,
      timeout,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve((response.statusCode ?? 500) < 400));
    });
    request.once("timeout", () => { request.destroy(); resolve(false); });
    request.once("error", () => resolve(false));
    request.end();
  });
}

async function startCameraStreamer() {
  if (recorderStarting || recorderProcess || calibrationRunning) {
    throw new Error("Stop the recorder before starting the camera streamer");
  }
  if (await callCameraStreamer("/api/health", "GET")) return;
  if (recorderStarting || recorderProcess || calibrationRunning) throw new Error("Cameras are in use");
  if (cameraStreamerProcess && cameraStreamerProcess.exitCode === null) return;

  const child = spawn(cameraStreamerExecutable, [], {
    cwd: dirname(cameraStreamerExecutable),
    env: process.env,
  });
  cameraStreamerProcess = child;
  appendProcessLog(cameraStreamerLogs, "stdout", `Starting ${cameraStreamerExecutable}`);
  captureProcessOutput(child, cameraStreamerLogs, "camera streamer");
  child.once("close", () => {
    if (cameraStreamerProcess === child) cameraStreamerProcess = null;
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  for (let attempt = 0; attempt < 100; ++attempt) {
    if (await callCameraStreamer("/api/health", "GET")) return;
    if (child.exitCode !== null) throw new Error(`Camera streamer exited with code ${child.exitCode}`);
    await delay(100);
  }
  throw new Error("Camera streamer did not become ready within 10 seconds");
}

async function startRecorder(recordingName: string, saveDirectory: string, mode: RecorderMode) {
  if (recorderStarting || recorderProcess || calibrationRunning) throw new Error("Cameras are already in use by a recorder or calibration");
  recorderStarting = true;
  recorderMode = mode;
  recorderSession = { name: recordingName, saveDirectory };
  try {
    if (!saveDirectory) {
      const settings = JSON.parse(await readFile(settingsDocuments.camera.file, "utf8")) as { save_dir?: string };
      saveDirectory = settings.save_dir?.trim() ?? "";
    }
    if (!saveDirectory) throw new Error("Choose a save directory");
    recorderSession = { name: recordingName, saveDirectory };
    await stopCameraStreamer();
    recorderLogs = [];
    const executable = mode === "hrsoc" ? eyeRecorderExecutable : recorderExecutable;
    appendProcessLog(recorderLogs, "stdout", `Starting ${executable}`);
    const child = spawn(executable, [], {
      cwd: dirname(executable),
      env: { ...process.env, CAMERA_SETTINGS_FILE: settingsDocuments.camera.file,
        EYE_TRACKER_SETTINGS_FILE: eyeTrackerSettingsFile,
        RECORDING_NAME: recordingName, RECORDING_SAVE_DIR: saveDirectory },
    });
    recorderProcess = child;
    recorderMode = mode;
    recorderReady = false;
    recorderStartedAt = null;
    captureProcessOutput(child, recorderLogs, "recorder");
    let startupOutput = "";
    let announcedReady = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      startupOutput = (startupOutput + chunk.toString()).slice(-4000);
      if (!announcedReady && startupOutput.includes("Synchronized recording started")) {
        announcedReady = true;
        recorderReady = true;
        recorderStartedAt = Date.now();
      }
    });
    child.once("close", (exitCode, signal) => {
      appendProcessLog(
        recorderLogs,
        exitCode === 0 ? "stdout" : "stderr",
        signal ? `Recorder stopped by signal ${signal}` : `Recorder exited with code ${exitCode ?? "unknown"}`,
      );
      if (recorderProcess === child) {
        recorderProcess = null;
        recorderStartedAt = null;
        recorderReady = false;
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    for (let attempt = 0; attempt < 300; ++attempt) {
      if (recorderProcess !== child) throw new Error("Recorder exited during startup. See recorder output.");
      if (recorderReady) return;
      await delay(100);
    }
    await stopRecorder();
    throw new Error("Recorder did not become ready within 30 seconds. See recorder output.");
  } finally {
    recorderStarting = false;
  }
}

async function stopRecorder() {
  if (recorderStopping) return recorderStopping;
  const child = recorderProcess;
  if (!child) return;
  recorderStopping = (async () => {
    recorderReady = false;
    appendProcessLog(recorderLogs, "stdout", "Stopping recorder");
    child.kill("SIGINT");
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timeout); child.off("close", finish); resolve(); };
      const timeout = setTimeout(finish, 20000);
      child.once("close", finish);
    });
    if (recorderProcess === child) throw new Error("Recorder is still finalizing videos and timestamps. Wait and try stopping again.");
  })();
  try { await recorderStopping; } finally { recorderStopping = null; }
}

type EyeStatus = {
  trackers: Array<{ name: string; endpoint: string; connected: boolean; message: string }>;
  refreshIntervalMs: number;
  checkedAt: number;
};
let eyeStatus: EyeStatus | null = null;
let eyeStatusProbe: Promise<EyeStatus> | null = null;
let eyeStatusSettings = "";

async function getEyeStatus(): Promise<EyeStatus> {
  const contents = await readFile(eyeTrackerSettingsFile, "utf8");
  if (eyeStatus && eyeStatusSettings === contents && Date.now() - eyeStatus.checkedAt < eyeStatus.refreshIntervalMs) return eyeStatus;
  if (eyeStatusProbe) return eyeStatusProbe;
  eyeStatusProbe = new Promise<EyeStatus>((resolve, reject) => {
    const child = spawn(eyeRecorderExecutable, ["--status", eyeTrackerSettingsFile], { env: process.env });
    let output = "";
    let errors = "";
    const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Eye tracker status check timed out")); }, 12000);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(errors.trim() || "Eye tracker status check failed")); return; }
      try {
        const status = { ...JSON.parse(output), checkedAt: Date.now() } as EyeStatus;
        eyeStatus = status;
        eyeStatusSettings = contents;
        resolve(status);
      } catch { reject(new Error("Invalid eye tracker status response")); }
    });
  });
  try { return await eyeStatusProbe; } finally { eyeStatusProbe = null; }
}

async function stopCameraStreamer() {
  await callCameraStreamer("/api/shutdown", "POST", 1000);
  for (let attempt = 0; attempt < 30; ++attempt) {
    if (!await callCameraStreamer("/api/health", "GET", 150)) break;
    await delay(100);
  }
  const child = cameraStreamerProcess;
  if (!child || child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    delay(1500),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("close", () => resolve())),
      delay(1000),
    ]);
  }
}

function localCalibrationApi(): Plugin {
  return {
    name: "local-calibration-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const parsedRequest = new URL(request.url ?? "/", "http://localhost");
        const requestPath = parsedRequest.pathname;
        const afterLogId = Number(parsedRequest.searchParams.get("after") ?? 0);

        if (requestPath === "/local-api/eye-trackers/status" && request.method === "GET") {
          void getEyeStatus().then((status) => sendJson(response, 200, status))
            .catch((error: unknown) => sendJson(response, 500, { error: error instanceof Error ? error.message : "Could not check eye trackers" }));
          return;
        }

        if (requestPath === "/local-api/recorder/config" && request.method === "GET") {
          void readFile(settingsDocuments.camera.file, "utf8").then((contents) => {
            const settings = JSON.parse(contents) as { save_dir: string; cams: Array<{ serial: string }>; fps: number; img_width: number; img_height: number };
            sendJson(response, 200, { saveDirectory: settings.save_dir, cameras: settings.cams, fps: settings.fps, width: settings.img_width, height: settings.img_height });
          }).catch((error: unknown) => sendJson(response, 500, { error: error instanceof Error ? error.message : "Could not load recorder configuration" }));
          return;
        }

        if (requestPath === "/local-api/camera-stream/status" && request.method === "GET") {
          void callCameraStreamer("/api/health", "GET").then((streaming) => {
            sendJson(response, 200, {
              streaming,
              logs: cameraStreamerLogs.filter((entry) => entry.id > afterLogId),
            });
          });
          return;
        }

        if (requestPath === "/local-api/recorder/status" && request.method === "GET") {
          sendJson(response, 200, {
            recording: Boolean(recorderProcess || recorderStarting),
            mode: recorderMode,
            ready: recorderReady,
            session: recorderSession,
            startedAt: recorderStartedAt,
            logs: recorderLogs.filter((entry) => entry.id > afterLogId),
          });
          return;
        }

        if (requestPath === "/local-api/recorder/start" && request.method === "POST") {
          void readRequestJson(request).then((payload) => {
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Recorder settings must be an object");
            const candidate = payload as Record<string, unknown>;
            const name = candidate.name;
            if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,120}$/.test(name) || name === "." || name === "..")
              throw new Error("Choose a session name using letters, numbers, underscores, dots or hyphens");
            if (candidate.mode !== undefined && candidate.mode !== "camera" && candidate.mode !== "hrsoc") throw new Error("Unknown recorder mode");
            const saveDirectory = candidate.saveDirectory;
            if (saveDirectory !== undefined && (typeof saveDirectory !== "string" || saveDirectory.includes("\0"))) throw new Error("Invalid save directory");
            return startRecorder(name, typeof saveDirectory === "string" ? saveDirectory.trim() : "", candidate.mode === "hrsoc" ? "hrsoc" : "camera");
          }).then(() => sendJson(response, 200, { recording: Boolean(recorderProcess), startedAt: recorderStartedAt }))
            .catch((error: unknown) => sendJson(response, 500, {
              error: error instanceof Error ? error.message : "Could not start recorder",
            }));
          return;
        }

        if (requestPath === "/local-api/recorder/stop" && request.method === "POST") {
          void stopRecorder()
            .then(() => sendJson(response, 200, { recording: false }))
            .catch((error: unknown) => sendJson(response, 500, {
              error: error instanceof Error ? error.message : "Could not stop recorder",
            }));
          return;
        }

        if (requestPath === "/local-api/camera-stream/start" && request.method === "POST") {
          void startCameraStreamer()
            .then(() => sendJson(response, 200, { streaming: true }))
            .catch((error: unknown) => sendJson(response, 500, {
              error: error instanceof Error ? error.message : "Could not start camera streamer",
            }));
          return;
        }

        if (requestPath === "/local-api/camera-stream/stop" && request.method === "POST") {
          void stopCameraStreamer()
            .then(() => sendJson(response, 200, { streaming: false }))
            .catch((error: unknown) => sendJson(response, 500, {
              error: error instanceof Error ? error.message : "Could not stop camera streamer",
            }));
          return;
        }

        if (requestPath === "/local-api/settings" && request.method === "GET") {
          void (async () => {
            try {
              const [calibration, camera] = await Promise.all([
                readFile(settingsDocuments.calibration.file, "utf8").then(JSON.parse),
                readFile(settingsDocuments.camera.file, "utf8").then(JSON.parse),
              ]);
              sendJson(response, 200, { calibration, camera });
            } catch (error) {
              const message = error instanceof Error ? error.message : "Could not load settings";
              sendJson(response, 500, { error: message });
            }
          })();
          return;
        }

        if (requestPath === "/local-api/settings" && request.method === "PUT") {
          void (async () => {
            try {
              const payload = await readRequestJson(request);
              if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
                sendJson(response, 400, { error: "Settings payload must be an object" });
                return;
              }
              const candidate = payload as Record<string, unknown>;
              if (!("calibration" in candidate) || !("camera" in candidate)) {
                sendJson(response, 400, { error: "Both calibration and camera settings are required" });
                return;
              }

              const [calibrationSchema, cameraSchema] = await Promise.all([
                readFile(settingsDocuments.calibration.schema, "utf8").then(JSON.parse),
                readFile(settingsDocuments.camera.schema, "utf8").then(JSON.parse),
              ]);
              const calibrationValidator = new Ajv({ allErrors: true, strict: false }).compile(calibrationSchema);
              const cameraValidator = new Ajv({ allErrors: true, strict: false }).compile(cameraSchema);
              const calibrationValid = calibrationValidator(candidate.calibration);
              const cameraValid = cameraValidator(candidate.camera);
              const details = [
                ...formatValidationErrors("Calibration settings", calibrationValidator.errors),
                ...formatValidationErrors("Camera settings", cameraValidator.errors),
              ];
              if (!calibrationValid || !cameraValid) {
                sendJson(response, 422, {
                  error: "The configuration does not match its schema. Nothing was saved.",
                  details,
                });
                return;
              }

              await Promise.all([
                atomicWriteJson(settingsDocuments.calibration.file, candidate.calibration),
                atomicWriteJson(settingsDocuments.camera.file, candidate.camera),
              ]);
              sendJson(response, 200, { success: true });
            } catch (error) {
              const message = error instanceof Error ? error.message : "Could not save settings";
              sendJson(response, 500, { error: message });
            }
          })();
          return;
        }

        if (request.method === "POST" &&
            (requestPath === "/local-api/calibration/run" ||
             requestPath === "/local-api/calibration/validate")) {
          if (calibrationRunning || recorderStarting) {
            sendJson(response, 409, { error: "Wait for the active capture operation to finish" });
            return;
          }
          calibrationRunning = true;
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.flushHeaders();

          let finished = false;

          const send = (event: object) => {
            if (!response.writableEnded && !response.destroyed) {
              response.write(`${JSON.stringify(event)}\n`);
            }
          };

          const complete = (success: boolean, exitCode: number | null) => {
            if (finished) return;
            finished = true;
            calibrationRunning = false;
            stat(calibrationResult, (error, file) => {
              send({
                type: "complete",
                success,
                exitCode,
                resultAvailable: success && !error && file.isFile(),
              });
              response.end();
            });
          };

          const runStage = (stageIndex: number) => {
            if (stageIndex >= calibrationStages.length) {
              complete(true, 0);
              return;
            }

            const stage = calibrationStages[stageIndex];
            let stdoutRemainder = "";
            let stderrRemainder = "";
            let stageFinished = false;
            send({ type: "stage", stage: stage.id, state: "running" });
            send({ type: "log", stream: "stdout", message: `$ ${stage.script}` });

            const child = spawn("stdbuf", ["-oL", "-eL", "/bin/bash", stage.script], {
              cwd: dirname(stage.script),
              env: {
                ...process.env,
                PYTHONUNBUFFERED: "1",
                FORCE_COLOR: "1",
                TERM: "xterm-256color",
              },
            });
            const emitLines = (stream: "stdout" | "stderr", chunk: Buffer) => {
              const previous = stream === "stdout" ? stdoutRemainder : stderrRemainder;
              const lines = `${previous}${chunk.toString()}`.split(/\r\n|\r|\n/);
              const remainder = lines.pop() ?? "";
              if (stream === "stdout") stdoutRemainder = remainder;
              else stderrRemainder = remainder;
              lines.filter(Boolean).forEach((message) => send({ type: "log", stream, message }));
            };
            const flushOutput = () => {
              if (stdoutRemainder) send({ type: "log", stream: "stdout", message: stdoutRemainder });
              if (stderrRemainder) send({ type: "log", stream: "stderr", message: stderrRemainder });
            };

            child.stdout.on("data", (chunk: Buffer) => emitLines("stdout", chunk));
            child.stderr.on("data", (chunk: Buffer) => emitLines("stderr", chunk));
            child.once("error", (error) => {
              if (stageFinished) return;
              stageFinished = true;
              flushOutput();
              send({ type: "log", stream: "stderr", message: `${stage.label} could not start: ${error.message}` });
              send({ type: "stage", stage: stage.id, state: "error" });
              complete(false, null);
            });
            child.once("close", (exitCode, signal) => {
              if (stageFinished) return;
              stageFinished = true;
              flushOutput();
              if (exitCode !== 0) {
                const reason = signal ? `signal ${signal}` : `exit code ${exitCode ?? "unknown"}`;
                send({ type: "log", stream: "stderr", message: `${stage.label} failed with ${reason}` });
                send({ type: "stage", stage: stage.id, state: "error" });
                complete(false, exitCode);
                return;
              }
              send({ type: "stage", stage: stage.id, state: "success" });
              send({ type: "log", stream: "stdout", message: `${stage.label} completed successfully` });
              runStage(stageIndex + 1);
            });
          };

          send({ type: "log", stream: "stdout", message: "Releasing cameras before calibration" });
          void stopRecorder().then(stopCameraStreamer).then(() => {
            send({ type: "log", stream: "stdout", message: "Camera streamer stopped" });
            runStage(requestPath === "/local-api/calibration/validate" ? 2 : 0);
          }).catch((error: unknown) => {
            send({ type: "log", stream: "stderr", message: error instanceof Error ? error.message : "Could not release cameras" });
            complete(false, null);
          });
          return;
        }

        if (request.method === "GET" && requestPath === "/local-api/calibration/result") {
          stat(calibrationResult, (error, file) => {
            if (error || !file.isFile()) {
              response.statusCode = 404;
              response.end("Calibration result not found");
              return;
            }
            response.statusCode = 200;
            response.setHeader("Content-Type", "image/jpeg");
            response.setHeader("Content-Length", file.size);
            response.setHeader("Cache-Control", "no-store");
            createReadStream(calibrationResult).pipe(response);
          });
          return;
        }

        if (request.method === "GET" && requestPath === "/local-api/calibration/latest-json") {
          void (async () => {
            try {
              const entries = await readdir(calibrationLogsDirectory, { withFileTypes: true });
              const candidates = await Promise.all(entries
                .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
                .map(async (entry) => {
                  const path = `${calibrationLogsDirectory}/${entry.name}`;
                  return { path, modified: (await statAsync(path)).mtimeMs };
                }));
              const latest = candidates.sort((left, right) => right.modified - left.modified)[0];
              if (!latest) {
                sendJson(response, 404, { error: "No calibration JSON file was found" });
                return;
              }
              const contents = await readFile(latest.path, "utf8");
              response.statusCode = 200;
              response.setHeader("Content-Type", "application/json; charset=utf-8");
              response.setHeader("Cache-Control", "no-store");
              response.end(contents);
            } catch (error) {
              const message = error instanceof Error ? error.message : "Could not read calibration JSON";
              sendJson(response, 500, { error: message });
            }
          })();
          return;
        }

        if (request.method === "GET" && requestPath === "/local-api/calibration/guide") {
          stat(calibrationGuide, (error, file) => {
            if (error || !file.isFile()) {
              response.statusCode = 404;
              response.end("Calibration guide not found");
              return;
            }
            response.statusCode = 200;
            response.setHeader("Content-Type", "image/gif");
            response.setHeader("Content-Length", file.size);
            response.setHeader("Cache-Control", "no-store");
            createReadStream(calibrationGuide).pipe(response);
          });
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [localCalibrationApi(), react()],
  publicDir: "public",
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
});
