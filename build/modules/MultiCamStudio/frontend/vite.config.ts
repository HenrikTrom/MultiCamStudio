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
  { id: "capture", label: "Capture", script: "/home/docker/workspace/workspace/flirmulticamera_gui/backend/scripts/record.sh" },
  { id: "calibrate", label: "Calibrate", script: "/home/docker/workspace/workspace/flirmulticamera_gui/backend/scripts/calibrate.sh" },
  { id: "validate", label: "Validate", script: "/home/docker/workspace/workspace/flirmulticamera_gui/backend/scripts/validate.sh" },
] as const;
const calibrationResult =
  "/home/docker/workspace/workspace/multi-camera-calib/test/back_projeced3d.jpg";
const calibrationGuide =
  "/home/docker/workspace/workspace/flirmulticamera_gui/content/result.gif";
const calibrationLogsDirectory =
  "/home/docker/workspace/workspace/multi-camera-calib/data/logs";
const cameraStreamerExecutable = process.env.FLIR_STREAMER_EXECUTABLE ??
  "/home/docker/workspace/workspace/flirmulticamera_gui/backend/build/fast_flir_web_streamer";
const recorderExecutable = process.env.FLIR_RECORDER_EXECUTABLE ??
  "/home/docker/workspace/workspace/flirmulticamera_gui/backend/build/flir_recorder";
const cameraStreamerPort = 8080;
let cameraStreamerProcess: ReturnType<typeof spawn> | null = null;
let recorderProcess: ReturnType<typeof spawn> | null = null;
let recorderStartedAt: number | null = null;
type ProcessLog = { id: number; stream: "stdout" | "stderr"; message: string };
let nextProcessLogId = 1;
let cameraStreamerLogs: ProcessLog[] = [];
let recorderLogs: ProcessLog[] = [];
const settingsDocuments = {
  calibration: {
    file: "/home/docker/workspace/workspace/multi-camera-calib/cfg/CameraCalibrationSettings.json",
    schema: "/home/docker/workspace/workspace/multi-camera-calib/cfg/CameraCalibrationSettings.schema.json",
  },
  camera: {
    file: "/home/docker/workspace/cfg/camera_settings_1024x768.json",
    schema: "/home/docker/workspace/build/dependencies/flirmulticamera/cfg/CameraSettings.Schema.json",
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
  if (recorderProcess && recorderProcess.exitCode === null) {
    throw new Error("Stop the recorder before starting the camera streamer");
  }
  if (await callCameraStreamer("/api/health", "GET")) return;
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

async function startRecorder(recordingName: string) {
  if (recorderProcess && recorderProcess.exitCode === null) return;
  await stopCameraStreamer();
  recorderLogs = [];
  appendProcessLog(recorderLogs, "stdout", `Starting ${recorderExecutable}`);
  const child = spawn(recorderExecutable, [], {
    cwd: dirname(recorderExecutable),
    env: { ...process.env, RECORDING_NAME: recordingName },
  });
  recorderProcess = child;
  recorderStartedAt = Date.now();
  captureProcessOutput(child, recorderLogs, "recorder");
  child.once("close", (exitCode, signal) => {
    appendProcessLog(
      recorderLogs,
      exitCode === 0 ? "stdout" : "stderr",
      signal ? `Recorder stopped by signal ${signal}` : `Recorder exited with code ${exitCode ?? "unknown"}`,
    );
    if (recorderProcess === child) recorderProcess = null;
    recorderStartedAt = null;
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function stopRecorder() {
  const child = recorderProcess;
  if (!child || child.exitCode !== null) return;
  appendProcessLog(recorderLogs, "stdout", "Stopping recorder");
  child.kill("SIGINT");
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    delay(5000),
  ]);
  if (child.exitCode === null) child.kill("SIGTERM");
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
            recording: Boolean(recorderProcess && recorderProcess.exitCode === null),
            startedAt: recorderStartedAt,
            logs: recorderLogs.filter((entry) => entry.id > afterLogId),
          });
          return;
        }

        if (requestPath === "/local-api/recorder/start" && request.method === "POST") {
          void readRequestJson(request).then((payload) => {
            const requestedName = payload && typeof payload === "object" && !Array.isArray(payload)
              ? String((payload as Record<string, unknown>).name ?? "recording")
              : "recording";
            const recordingName = requestedName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "recording";
            return startRecorder(recordingName);
          }).then(() => sendJson(response, 200, { recording: true, startedAt: recorderStartedAt }))
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
  publicDir: false,
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
