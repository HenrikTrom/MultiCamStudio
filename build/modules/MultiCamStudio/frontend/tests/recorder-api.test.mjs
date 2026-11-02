import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

// Exercise the actual Vite process API without acquiring laboratory hardware.
test("recorder selection, status, exclusivity, logs and graceful stop", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "hrsoc-recorder-api-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const eyeSettings = join(temporary, "eye_tracker_settings.json");
  const cameraSettings = join(temporary, "camera.json");
  await writeFile(eyeSettings, JSON.stringify({ eye_trackers: [] }));
  await writeFile(cameraSettings, JSON.stringify({ save_dir: temporary, cams: [{ serial: "123" }], fps: 60, img_width: 1024, img_height: 768 }));
  const mock = (kind) => `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
if (process.argv[2] === '--status') {
  try {
    JSON.parse(readFileSync(process.argv[3], 'utf8'));
    console.log(JSON.stringify({trackers: [], refreshIntervalMs: 1000}));
    process.exit(0);
  } catch { console.error('Invalid eye tracker settings'); process.exit(1); }
}
if (process.env.RECORDING_NAME === 'fail') { console.error('Camera configuration failed'); process.exit(2); }
console.log('${kind} ' + JSON.stringify({name: process.env.RECORDING_NAME, path: process.env.RECORDING_SAVE_DIR}));
console.log('Synchronized recording started');
process.on('SIGINT', () => {
  console.log('Finalizing videos and timestamps');
  setTimeout(() => { writeFileSync(process.env.RECORDING_SAVE_DIR + '/finalized', 'yes'); process.exit(0); }, 150);
});
setInterval(() => {}, 1000);
`;
  const cameraExecutable = join(temporary, "camera-recorder.mjs");
  const eyeExecutable = join(temporary, "eye-recorder.mjs");
  await writeFile(cameraExecutable, mock("camera"), { mode: 0o755 });
  await writeFile(eyeExecutable, mock("hrsoc"), { mode: 0o755 });
  process.env.CAMERA_SETTINGS_FILE = cameraSettings;
  process.env.EYE_TRACKER_SETTINGS_FILE = eyeSettings;
  process.env.FLIR_RECORDER_EXECUTABLE = cameraExecutable;
  process.env.FLIR_EYE_RECORDER_EXECUTABLE = eyeExecutable;

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const server = await createServer({ root, configFile: join(root, "vite.config.ts"), server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { code: response.status, body: await response.json() };
  };
  context.after(async () => {
    await call("/local-api/recorder/stop", {}).catch(() => {});
    await server.close();
  });

  let result = await call("/local-api/recorder/config");
  assert.equal(result.body.saveDirectory, temporary);
  assert.equal(result.body.cameras[0].serial, "123");
  result = await call("/local-api/eye-trackers/status");
  assert.equal(result.code, 200);
  assert.deepEqual(result.body.trackers, []);
  assert.equal(typeof result.body.checkedAt, "number");
  result = await call("/local-api/recorder/start", { name: "..", mode: "hrsoc" });
  assert.ok(result.code >= 400);
  result = await call("/local-api/recorder/start", { name: "session", saveDirectory: temporary, mode: "hrsoc" });
  assert.equal(result.code, 200);
  assert.equal(result.body.recording, true);
  result = await call("/local-api/recorder/status");
  assert.equal(result.body.mode, "hrsoc");
  assert.equal(result.body.ready, true);
  assert.equal(result.body.session.saveDirectory, temporary);
  assert.ok(result.body.logs.some((entry) => entry.message.startsWith("hrsoc ")));
  const lastId = result.body.logs.at(-1).id;
  result = await call(`/local-api/recorder/status?after=${lastId}`);
  assert.deepEqual(result.body.logs, []);
  result = await call("/local-api/recorder/start", { name: "other", mode: "camera" });
  assert.ok(result.code >= 400);
  result = await call("/local-api/camera-stream/start", {});
  assert.ok(result.code >= 400);
  result = await call("/local-api/recorder/stop", {});
  assert.equal(result.code, 200);
  assert.equal(await readFile(join(temporary, "finalized"), "utf8"), "yes");
  result = await call("/local-api/recorder/status");
  assert.equal(result.body.recording, false);
  assert.equal(result.body.ready, false);
  result = await call("/local-api/recorder/start", { name: "camera-session", saveDirectory: temporary, mode: "camera" });
  assert.equal(result.code, 200);
  result = await call("/local-api/recorder/status");
  assert.equal(result.body.mode, "camera");
  assert.ok(result.body.logs.some((entry) => entry.message.startsWith("camera ")));
  await call("/local-api/recorder/stop", {});
  result = await call("/local-api/recorder/start", { name: "fail", saveDirectory: temporary, mode: "hrsoc" });
  assert.ok(result.code >= 400);
  result = await call("/local-api/recorder/status");
  assert.equal(result.body.recording, false);
  assert.ok(result.body.logs.some((entry) => entry.message.includes("Camera configuration failed")));
  const concurrent = await Promise.all([
    call("/local-api/recorder/start", { name: "concurrent-a", mode: "camera" }),
    call("/local-api/recorder/start", { name: "concurrent-b", mode: "hrsoc" }),
  ]);
  assert.equal(concurrent.filter((entry) => entry.code === 200).length, 1);
  assert.equal(concurrent.filter((entry) => entry.code >= 400).length, 1);
  result = await call("/local-api/recorder/status");
  assert.equal(result.body.session.saveDirectory, temporary, "Omitted directory must use camera settings");
  await call("/local-api/recorder/stop", {});
  await writeFile(eyeSettings, "invalid JSON");
  result = await call("/local-api/eye-trackers/status");
  assert.ok(result.code >= 400);
});
