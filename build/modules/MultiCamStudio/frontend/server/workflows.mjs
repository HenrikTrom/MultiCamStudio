import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const binaryRoot = '/opt/mcs/ros2/lib/ros2_multicam_interface';
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const exists = (path) => access(path).then(() => true, () => false);
const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
};
async function body(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 16000) throw new Error('Request is too large');
  }
  return text ? JSON.parse(text) : {};
}
async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, path);
}
function settingsValid(config, calibration = false) {
  const ids = config.serial_numbers;
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_]+$/.test(id))) {
    throw new Error('Camera settings require unique serial_numbers');
  }
  if (!calibration) return;
  if (ids.length < 2 || ids.some((id) => !/^\d+$/.test(id)) || !ids.includes(config.main_cam_serial)) {
    throw new Error('Calibration requires at least two numeric camera IDs and a configured main_cam_serial');
  }
  for (const key of ['pattern_size_first', 'pattern_size_second', 'charuco_params_dict',
    'charuco_params_marker_border_pixel']) {
    if (!Number.isInteger(config[key]) || config[key] < (key === 'charuco_params_dict' ? 0 : 1))
      throw new Error('Invalid calibration setting: ' + key);
  }
  for (const key of ['charuco_params_square_size', 'charuco_params_border_size', 'charuco_params_marker_to_square_ratio']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error('Invalid calibration setting: ' + key);
  }
  if (config.pattern_size_first < 3 || config.pattern_size_second < 3 || config.charuco_params_marker_to_square_ratio >= 1)
    throw new Error('Invalid calibration board geometry');
}

export function createWorkflows(options) {
  const configPath = options.config;
  const dataRoot = resolve(options.dataRoot ?? process.env.CALIBRATION_DATA ?? '/home/docker/workspace/data');
  const recorderExecutable = options.recorderExecutable ?? process.env.ROS_RECORDER_EXECUTABLE ?? `${binaryRoot}/recording_tab_ros2_image_recorder`;
  const captureExecutable = options.captureExecutable ?? process.env.ROS_CALIBRATION_RECORDER_EXECUTABLE ?? `${binaryRoot}/calibration_tab_ros2_image_recorder`;
  const calibratorExecutable = options.calibratorExecutable ?? '/opt/mcs/calibration/bin/Multi_Camera_Calibration';
  const python = options.python ?? process.env.MCS_PYTHON_EXECUTABLE ?? '/opt/mcs/python/bin/python3';
  const validator = options.validator ?? process.env.ROS_CALIBRATION_CHECK_SCRIPT ?? `${binaryRoot}/check_calibration.py`;
  let active = null;
  let recorder = null;
  let recorderStarting = false;
  let recordCancelled = false;
  let recorderReady = false;
  let recorderStartedAt = null;
  let recorderSession = null;
  let recorderError = '';
  let recorderProgress = null;
  let stoppingRecorder = null;
  const recorderLogs = [];
  let nextLog = 1;
  let pipeline = null;
  let pipelineChild = null;
  let cancelled = false;
  let latestCalibration = null;
  let previewPath = null;
  let calibration = { running: false, stages: { capture: 'pending', calibrate: 'pending', validate: 'pending' },
    sessionDirectory: null, result: null, logs: [] };
  const append = (target, stream, message) => {
    target.push({ id: nextLog++, stream, message });
    if (target.length > 2000) target.splice(0, target.length - 2000);
    console.log(`[${target === recorderLogs ? 'recorder' : 'calibration'}] ${message}`);
  };
  const readConfig = async () => {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    settingsValid(config);
    return config;
  };
  const within = (path) => {
    const rel = relative(dataRoot, resolve(path));
    if (rel === '..' || rel.startsWith('..' + sep) || resolve(path) === '/') throw new Error('Choose a save directory inside ' + dataRoot);
    return resolve(path);
  };
  const writableDirectory = async (path) => {
    const target = within(path);
    // Check existing ancestors before creating directories, including symlinks.
    let ancestor = target;
    while (!await exists(ancestor)) ancestor = dirname(ancestor);
    const actual = await realpath(ancestor);
    if (await exists(dataRoot)) {
      const root = await realpath(dataRoot);
      const rel = relative(root, actual);
      // A not-yet-created data root may have its parent as the existing ancestor.
      if (ancestor !== dirname(dataRoot) && (rel === '..' || rel.startsWith('..' + sep))) throw new Error('Save directory resolves outside the data mount');
    }
    await mkdir(target, { recursive: true });
    return target;
  };
  const pointer = join(dataRoot, 'calibration', 'latest.json');
  const initialized = (async () => {
    try {
      const saved = JSON.parse(await readFile(pointer, 'utf8'));
      if (saved.calibration && within(saved.calibration) && await exists(saved.calibration)) latestCalibration = saved.calibration;
      if (saved.preview && within(saved.preview) && await exists(saved.preview)) previewPath = saved.preview;
      calibration.result = saved.result ?? null;
    } catch { /* A new workspace has no published calibration yet. */ }
  })();
  async function latest() {
    await initialized;
    if (latestCalibration && await exists(latestCalibration)) return latestCalibration;
    const config = await readConfig();
    const directory = within(config.savedir || join(dataRoot, 'logs'));
    const candidates = (await readdir(directory).catch(() => [])).filter((name) => /^Calibration\d+x\d+\.json$/.test(name));
    const files = await Promise.all(candidates.map(async (name) => ({ path: join(directory, name), time: (await stat(join(directory, name))).mtimeMs })));
    return files.sort((a, b) => b.time - a.time)[0]?.path ?? null;
  }
  function launch(executable, args, environment, logs, onEvent = () => {}) {
    const child = spawn(executable, args, { env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    for (const stream of ['stdout', 'stderr']) createInterface({ input: child[stream] }).on('line', (line) => {
      let event = null;
      if (stream === 'stdout') {
        try { event = JSON.parse(line); } catch { /* Native solver text. */ }
      }
      if (event?.event) {
        if (event.error) error = event.error;
        const message = event.event === 'ready' ? `Synchronized capture ready: ${event.cameras} cameras, ${event.width} × ${event.height}` :
          event.event === 'progress' ? `Saved ${event.frames} aligned frame sets` :
          event.event === 'complete' ? `Capture ${event.status}: ${event.frames} aligned frame sets${event.error ? ' — ' + event.error : ''}` : event.error || line;
        append(logs, event.error ? 'stderr' : stream, message);
        onEvent(event);
      } else append(logs, stream, line);
    });
    const done = new Promise((resolveDone) => {
      child.once('error', (reason) => { error = reason.message; append(logs, 'stderr', error); });
      child.once('close', (code, signal) => resolveDone({ code: code ?? 1, error: error || (signal ? 'Process stopped: ' + signal : '') }));
    });
    return { child, done };
  }
  async function terminate(process) {
    if (!process || process.child.exitCode !== null || process.child.signalCode !== null) return;
    const timer = setTimeout(() => process.child.kill('SIGKILL'), 10000);
    process.child.kill('SIGTERM');
    try { await process.done; } finally { clearTimeout(timer); }
  }
  const recordState = (after = 0) => ({ recording: Boolean(recorder || recorderStarting || stoppingRecorder),
    mode: recorder || recorderStarting ? 'camera' : null, ready: recorderReady,
    startedAt: recorderStartedAt, session: recorderSession, error: recorderError,
    progress: recorderProgress, calibrationRunning: calibration.running,
    logs: recorderLogs.filter((entry) => entry.id > after) });
  async function startRecording(request) {
    if (active) throw new Error('Stop the current recording or calibration first');
    active = 'recording'; recorderStarting = true; recordCancelled = false; recorderError = ''; recorderReady = false;
    recorderLogs.length = 0; recorderProgress = null;
    try {
      const values = await body(request);
      if (values.mode && values.mode !== 'camera') throw new Error('Only ROS camera recording is available');
      if (typeof values.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(values.name)) throw new Error('Use a session name containing letters, numbers, dots, underscores or hyphens');
      const config = await readConfig();
      const saveDirectory = await writableDirectory(values.saveDirectory || join(dataRoot, 'recordings'));
      const outputDirectory = join(saveDirectory, values.name);
      if (await exists(outputDirectory)) throw new Error('Session already exists; choose a new session name');
      const fps = Number(values.fps ?? process.env.RECORD_FPS ?? 30);
      if (!Number.isInteger(fps) || fps < 1 || fps > 240) throw new Error('Recording frequency must be an integer from 1 to 240 Hz');
      recorderSession = { name: values.name, saveDirectory, outputDirectory };
      // Freeze settings for the session without modifying the mounted configuration.
      const settingsDirectory = await writableDirectory(join(dataRoot, '.session-settings'));
      const snapshot = join(settingsDirectory, randomUUID() + '.json');
      await atomicJson(snapshot, config);
      let readyResolve, readyReject;
      const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
      if (recordCancelled) throw new Error('Recording cancelled');
      const current = launch(recorderExecutable, [snapshot, outputDirectory], { RECORD_FPS: String(fps) }, recorderLogs, (event) => {
        if (event.event === 'ready') { recorderReady = true; recorderStartedAt = Date.now(); readyResolve(); }
        if (event.event === 'progress' || event.event === 'complete') recorderProgress = event;
      });
      recorder = current;
      current.done.then((result) => {
        if (recorder === current) { recorder = null; recorderReady = false; recorderStartedAt = null; active = null; }
        if (result.code !== 0) recorderError = result.error || 'Recording failed; see recorder output';
        readyReject(new Error(recorderError || 'Recorder exited before it was ready'));
      });
      const timeout = setTimeout(() => readyReject(new Error('Timed out preparing the recorder; check camera timestamps and resolution')),
        (Number(process.env.RECORD_START_TIMEOUT_SEC || 15) + 3) * 1000);
      try { await ready; } catch (error) { await terminate(current); throw error; }
      finally { clearTimeout(timeout); }
      return recordState();
    } catch (error) {
      recorderError = error.message;
      if (!recorder) active = null;
      throw error;
    } finally { recorderStarting = false; }
  }
  async function stopRecording() {
    recordCancelled = true;
    if (stoppingRecorder) return stoppingRecorder;
    stoppingRecorder = (async () => { recorderReady = false; await terminate(recorder); })().finally(() => { stoppingRecorder = null; });
    return stoppingRecorder;
  }
  async function persistLatest(result) {
    await atomicJson(pointer, { calibration: latestCalibration, preview: previewPath, result });
  }
  async function stage(id, executable, args, environment = {}) {
    if (cancelled) throw new Error('Calibration cancelled');
    calibration.stages[id] = 'running';
    const process = launch(executable, args, environment, calibration.logs, (event) => {
      if (id === 'capture' && event.event === 'progress') calibration.captureProgress = event;
    });
    pipelineChild = process;
    const result = await process.done;
    pipelineChild = null;
    if (cancelled || result.code !== 0) {
      calibration.stages[id] = 'error';
      throw new Error(cancelled ? 'Calibration cancelled' : result.error || `${id} failed (exit code ${result.code}); see calibration output`);
    }
    calibration.stages[id] = 'success';
  }
  async function startCalibration(quick) {
    await initialized;
    if (active) throw new Error('Stop the current recording or calibration first');
    active = 'calibration'; cancelled = false;
    calibration = { running: true, stages: { capture: 'pending', calibrate: 'pending', validate: 'pending' },
      sessionDirectory: null, result: null, logs: [] };
    pipeline = (async () => {
      let candidate = null;
      let validationDirectory = null;
      try {
        const config = await readConfig();
        settingsValid(config, true);
        const publishDirectory = await writableDirectory(config.savedir || join(dataRoot, 'logs'));
        const root = await writableDirectory(join(dataRoot, 'calibration'));
        const session = join(root, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
        await mkdir(session);
        calibration.sessionDirectory = session;
        const logDirectory = join(session, 'logs'); await mkdir(logDirectory);
        const snapshot = join(session, 'settings.json');
        await atomicJson(snapshot, { ...config, savedir: logDirectory });
        validationDirectory = join(session, 'validation');
        previewPath = null;
        if (quick) {
          candidate = await latest();
          if (!candidate) throw new Error('No calibration is available yet. Run a full calibration first.');
        } else {
          const capture = join(session, 'capture');
          await stage('capture', captureExecutable, [snapshot, capture]);
          const manifest = JSON.parse(await readFile(join(capture, 'session.json'), 'utf8'));
          if (manifest.status !== 'complete' || manifest.frames < 3 || !manifest.width || !manifest.height)
            { calibration.stages.capture = 'error'; throw new Error('Calibration requires at least three complete synchronized image sets'); }
          await stage('calibrate', calibratorExecutable, [join(capture, 'images'), snapshot]);
          candidate = join(logDirectory, `Calibration${manifest.width}x${manifest.height}.json`);
          // The unmodified native tool can return zero after a solver failure.
          try {
            const result = JSON.parse(await readFile(candidate, 'utf8').catch(() => { throw new Error('The calibration solver did not produce a result'); }));
            const serials = result.CAMERAS?.map((camera) => camera.SerialNumber);
            if (!serials || serials.length !== config.serial_numbers.length || config.serial_numbers.some((id) => !serials.includes(id)))
              throw new Error('Calibration output does not contain the configured cameras');
            result.image_width = manifest.width; result.image_height = manifest.height;
            await atomicJson(candidate, result);
          } catch (error) { calibration.stages.calibrate = 'error'; throw error; }
        }
        await stage('validate', python, [validator, snapshot, validationDirectory, '--calibration-file', candidate]);
        if (cancelled) throw new Error('Calibration cancelled');
        if (!quick) {
          const destination = join(publishDirectory, basename(candidate));
          if (await exists(destination)) {
            const archive = join(publishDirectory, 'archive'); await mkdir(archive, { recursive: true });
            await copyFile(destination, join(archive, randomUUID() + '-' + basename(candidate)));
          }
          const temporary = destination + '.' + randomUUID() + '.tmp';
          await copyFile(candidate, temporary); await rename(temporary, destination);
        }
        latestCalibration = candidate;
        calibration.result = { success: true, error: '', resultAvailable: true };
      } catch (error) {
        append(calibration.logs, 'stderr', error.message);
        for (const id of ['capture', 'calibrate', 'validate']) {
          if (calibration.stages[id] === 'running') calibration.stages[id] = 'error';
        }
        calibration.result = { success: false, error: error.message, resultAvailable: false };
      } finally {
        if (validationDirectory && await exists(join(validationDirectory, 'back_projeced3d.jpg'))) {
          previewPath = join(validationDirectory, 'back_projeced3d.jpg');
          calibration.result.resultAvailable = true;
          try { calibration.result.report = JSON.parse(await readFile(join(validationDirectory, 'validation.json'), 'utf8')); } catch {}
        }
        calibration.result.finishedAt = Date.now();
        try { await persistLatest(calibration.result); } catch (error) { append(calibration.logs, 'stderr', 'Could not save calibration index: ' + error.message); }
        calibration.running = false; active = null; pipeline = null;
      }
    })();
    return { running: true };
  }
  async function cancelCalibration() {
    cancelled = true;
    await terminate(pipelineChild);
    if (pipeline) await pipeline;
  }
  async function serveFile(request, response, path, type) {
    if (!path || !await exists(path)) { json(response, 404, { error: 'No calibration result is available yet' }); return; }
    const file = await stat(path);
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': file.size,
      'Cache-Control': 'no-store', 'Last-Modified': file.mtime.toUTCString() });
    if (request.method === 'HEAD') response.end();
    else createReadStream(path).on('error', () => response.destroy()).pipe(response);
  }
  return {
    close: async () => { await Promise.all([stopRecording(), cancelCalibration()]); },
    handle: async (request, response, path, url) => {
      if (!path.startsWith('/local-api/recorder/') && !path.startsWith('/local-api/calibration/')) return false;
      await initialized;
      try {
        if (path === '/local-api/recorder/config' && request.method === 'GET') {
          const config = await readConfig();
          const snapshot = await options.cameraMetadata().catch(() => ({ cameras: [] }));
          const cameras = config.serial_numbers.map((serial) => {
            const camera = snapshot.cameras.find((entry) => entry.id === serial);
            return { serial, topic: camera?.topic ?? '', online: camera?.online ?? false,
              width: camera?.width ?? 0, height: camera?.height ?? 0, inputFps: camera?.input_fps ?? 0 };
          });
          json(response, 200, { saveDirectory: join(dataRoot, 'recordings'), cameras,
            fps: Number(process.env.RECORD_FPS || 30), width: cameras[0]?.width ?? 0, height: cameras[0]?.height ?? 0,
            syncToleranceMs: Number(process.env.RECORD_SYNC_TOLERANCE_MS || 5) });
        } else if (path === '/local-api/recorder/status' && request.method === 'GET') {
          json(response, 200, recordState(Number(url.searchParams.get('after') || 0)));
        } else if (path === '/local-api/recorder/start' && request.method === 'POST') {
          json(response, 200, await startRecording(request));
        } else if (path === '/local-api/recorder/stop' && request.method === 'POST') {
          await stopRecording(); json(response, 200, recordState());
        } else if (path === '/local-api/calibration/status' && request.method === 'GET') {
          json(response, 200, { ...calibration, logs: calibration.logs.filter((entry) => entry.id > Number(url.searchParams.get('after') || 0)) });
        } else if ((path === '/local-api/calibration/run' || path === '/local-api/calibration/validate') && request.method === 'POST') {
          json(response, 202, await startCalibration(path.endsWith('/validate')));
        } else if (path === '/local-api/calibration/cancel' && request.method === 'POST') {
          await cancelCalibration(); json(response, 200, { running: false });
        } else if (path === '/local-api/calibration/latest-json' && ['GET', 'HEAD'].includes(request.method)) {
          await serveFile(request, response, await latest(), 'application/json');
        } else if (path === '/local-api/calibration/result' && ['GET', 'HEAD'].includes(request.method)) {
          await serveFile(request, response, previewPath, 'image/jpeg');
        } else if (path === '/local-api/calibration/guide' && request.method === 'GET') {
          await serveFile(request, response, options.guide ?? '/opt/mcs/web/calibration-guide.gif', 'image/gif');
        } else json(response, 404, { error: 'Unknown recording/calibration endpoint' });
      } catch (error) { json(response, 400, { error: error.message }); }
      return true;
    },
  };
}
