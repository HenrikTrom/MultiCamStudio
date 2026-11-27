import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { timestampName } from './timestamps.mjs';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const binaryRoot = '/opt/mcs/ros2/lib/ros2_multicam_interface';
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const execute = promisify(execFile);
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

async function pngCapture(capture, serials) {
  const manifest = JSON.parse(await readFile(join(capture, 'session.json'), 'utf8'));
  if (manifest.status !== 'complete' || manifest.capture_format !== 'png' || !manifest.calibration_capture ||
      !Number.isInteger(manifest.frames) || manifest.frames < 3 || manifest.frames > 999 ||
      !Number.isInteger(manifest.width) || manifest.width < 1 || !Number.isInteger(manifest.height) || manifest.height < 1)
    throw new Error('Calibration requires at least three complete synchronized PNG image sets');
  const images = join(capture, 'images');
  const names = new Set((await readdir(images, { withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => entry.name));
  for (let frame = 1; frame <= manifest.frames; frame++) {
    for (const serial of serials) {
      const name = `cam${serial}-${String(frame).padStart(4, '0')}.png`;
      if (!names.has(name)) throw new Error('Missing synchronized calibration PNG: ' + name);
      await pngFile(join(images, name));
    }
  }
  return { manifest, images };
}
async function pngFile(path) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== 8 || !buffer.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('Invalid calibration PNG: ' + basename(path));
  } finally { await file.close(); }
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
  const bagRecorder = options.bagRecorder ?? process.env.ROS_BAG_RECORDER_SCRIPT ?? `${binaryRoot}/record_rosbag.py`;
  const captureExecutable = options.captureExecutable ?? process.env.ROS_CALIBRATION_RECORDER_EXECUTABLE ?? `${binaryRoot}/calibration_tab_ros2_image_recorder`;
  const calibratorExecutable = options.calibratorExecutable ?? '/opt/mcs/calibration/bin/Multi_Camera_Calibration';
  const python = options.python ?? process.env.MCS_PYTHON_EXECUTABLE ?? '/opt/mcs/python/bin/python3';
  const validator = options.validator ?? process.env.ROS_CALIBRATION_CHECK_SCRIPT ?? `${binaryRoot}/check_calibration.py`;
  let active = null;
  let closing = false;
  let recorder = null;
  let recorderStarting = false;
  let recordCancelled = false;
  let recorderReady = false;
  let recorderStartedAt = null;
  let recorderSession = null;
  let recorderError = '';
  let recorderProgress = null;
  let stoppingRecorder = null;
  let frameProcess = null;
  let frameStarting = false;
  let frameSession = null;
  let frameError = '';
  let topicCache = null;
  let topicQuery = null;
  let topicCacheAt = 0;
  const now = () => options.now ? options.now() : new Date();
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
    const child = spawn(executable, args, { env: { ...process.env, ...environment },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    for (const stream of ['stdout', 'stderr']) createInterface({ input: child[stream] }).on('line', (line) => {
      let event = null;
      if (stream === 'stdout') {
        try { event = JSON.parse(line); } catch { /* Native solver text. */ }
      }
      if (event?.event) {
        if (event.error) error = event.error;
        const message = event.event === 'ready' ? (event.capture_format === 'rosbag2' ?
          `ROS bag recording: ${event.topics.length} selected topics` : `Synchronized capture ready: ${event.cameras} cameras, ${event.width} × ${event.height}`) :
          event.event === 'progress' ? (event.bytes_written !== undefined ? `${event.bytes_written} bag bytes written` : `Saved ${event.frames} aligned frame sets`) :
          event.event === 'complete' ? (event.capture_format === 'rosbag2' ? `ROS bag finalized: ${event.message_count} messages` :
            `Capture ${event.status}: ${event.frames} aligned frame sets${event.error ? ' — ' + event.error : ''}`) : event.error || line;
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
    const timer = setTimeout(() => {
      try {
        if (globalThis.process.platform !== 'win32') globalThis.process.kill(-process.child.pid, 'SIGKILL');
        else process.child.kill('SIGKILL');
      } catch { /* The process group already exited. */ }
    }, 25000);
    process.child.kill('SIGTERM');
    try { await process.done; } finally { clearTimeout(timer); }
  }
  const recordState = (after = 0) => ({ recording: Boolean(recorder || recorderStarting || stoppingRecorder),
    ready: recorderReady, startedAt: recorderStartedAt, session: recorderSession, error: recorderError,
    progress: recorderProgress, calibrationRunning: calibration.running,
    frameCapturing: Boolean(frameProcess || frameStarting), frameSession, frameError,
    logs: recorderLogs.filter((entry) => entry.id > after) });

  function cameraTopics(config) {
    const template = process.env.ROS_IMAGE_TOPIC_TEMPLATE || '/grasshopper/camera_{serial}/image_raw';
    if (template.split('{serial}').length !== 2) throw new Error('ROS_IMAGE_TOPIC_TEMPLATE must contain exactly one {serial}');
    return config.serial_numbers.map((serial) => ({ serial, topic: template.replace('{serial}', serial) }));
  }
  async function discoveredTopics() {
    if (topicCache && Date.now() - topicCacheAt < 5000) return topicCache;
    if (!topicQuery) topicQuery = (async () => {
      const topics = options.topicDiscovery ? await options.topicDiscovery() :
        JSON.parse((await execute(python, [bagRecorder, '--list-topics'], { timeout: 7000, maxBuffer: 1024 * 1024 })).stdout).topics;
      if (!Array.isArray(topics)) throw new Error('Invalid ROS topic discovery response');
      topicCache = topics; topicCacheAt = Date.now(); return topics;
    })().finally(() => { topicQuery = null; });
    return topicQuery;
  }
  async function recordingPath(directory, prefix = '') {
    const saveDirectory = await writableDirectory(directory || join(dataRoot, 'recordings'));
    const name = prefix + timestampName(now());
    const outputDirectory = join(saveDirectory, name);
    if (await exists(outputDirectory)) throw new Error('A recording with this timestamp already exists; wait for the next second');
    return { name, saveDirectory, outputDirectory };
  }
  async function startRecording(request) {
    if (closing) throw new Error('MCS is shutting down');
    if (active) throw new Error('Stop the current recording or calibration first');
    active = 'recording'; recorderStarting = true; recordCancelled = false; recorderError = ''; recorderReady = false;
    recorderLogs.length = 0; recorderProgress = null;
    try {
      const values = await body(request);
      if (values.name && values.name !== timestampName(now())) throw new Error('Recording names use the current YYYY-MM-DD-HH-mm-ss timestamp');
      const config = await readConfig();
      const topics = values.topics ?? cameraTopics(config).map((camera) => camera.topic);
      if (!Array.isArray(topics) || !topics.length || topics.length > 256 || topics.some((topic) =>
        typeof topic !== 'string' || topic.length > 255 || !/^\/[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(topic)))
        throw new Error('Select at least one valid ROS topic');
      recorderSession = { ...await recordingPath(values.saveDirectory), topics: [...new Set(topics)] };
      let readyResolve, readyReject;
      const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
      if (recordCancelled) throw new Error('Recording cancelled');
      const current = launch(python, [bagRecorder, '--output', recorderSession.outputDirectory,
        '--topics', ...recorderSession.topics], {}, recorderLogs, (event) => {
        if (event.event === 'ready') { recorderReady = true; recorderStartedAt = Date.now(); readyResolve(); }
        if (event.event === 'progress' || event.event === 'complete') recorderProgress = event;
      });
      recorder = current;
      current.done.then((result) => {
        if (recorder === current) { recorder = null; recorderReady = false; recorderStartedAt = null; active = null; }
        if (result.code !== 0) recorderError = result.error || 'ROS bag recording failed; see recorder output';
        readyReject(new Error(recorderError || 'Recorder exited before it was ready'));
      });
      const timeout = setTimeout(() => readyReject(new Error('Timed out starting ROS bag recording; see recorder output')),
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
  async function recordFrame(request) {
    if (closing) throw new Error('MCS is shutting down');
    if (active === 'calibration' || frameProcess || frameStarting) throw new Error('A frame capture or calibration is already running');
    frameStarting = true; frameError = '';
    let snapshot;
    try {
      const values = await body(request);
      const config = await readConfig();
      const session = await recordingPath(values.saveDirectory, 'frame_');
      const settingsDirectory = await writableDirectory(join(dataRoot, '.session-settings'));
      snapshot = join(settingsDirectory, randomUUID() + '.json');
      await atomicJson(snapshot, config);
      if (closing) throw new Error('MCS is shutting down');
      const current = launch(captureExecutable, ['--frame', snapshot, session.outputDirectory], {}, recorderLogs);
      frameProcess = current;
      const result = await current.done;
      if (result.code !== 0) throw new Error(result.error || 'Synchronized frame capture failed');
      const manifest = JSON.parse(await readFile(join(session.outputDirectory, 'session.json'), 'utf8'));
      if (manifest.status !== 'complete' || manifest.capture_format !== 'png' || manifest.frames !== 1)
        throw new Error('No complete synchronized frame set was saved');
      for (const serial of config.serial_numbers) await pngFile(join(session.outputDirectory, `cam${serial}.png`));
      frameSession = { ...session, width: manifest.width, height: manifest.height };
      append(recorderLogs, 'stdout', 'Synchronized PNG frame saved in ' + session.outputDirectory);
      return frameSession;
    } catch (error) { frameError = error.message; throw error; }
    finally { frameProcess = null; frameStarting = false; if (snapshot) await unlink(snapshot).catch(() => {}); }
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
    if (closing) throw new Error('MCS is shutting down');
    if (active || frameProcess || frameStarting) throw new Error('Stop the current recording or frame capture first');
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
        const session = join(root, timestampName(now()));
        if (await exists(session)) throw new Error('A calibration attempt for this second already exists; wait for the next second');
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
          let captured;
          try { captured = await pngCapture(capture, config.serial_numbers); }
          catch (error) { calibration.stages.capture = 'error'; throw error; }
          const { manifest, images } = captured;
          append(calibration.logs, 'stdout', `Captured ${manifest.frames} synchronized PNG sets in ${images}`);
          await stage('calibrate', calibratorExecutable, [images, snapshot]);
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
    close: async () => { closing = true; await Promise.all([stopRecording(), cancelCalibration(), terminate(frameProcess)]); },
    handle: async (request, response, path, url) => {
      if (!path.startsWith('/local-api/recorder/') && !path.startsWith('/local-api/calibration/')) return false;
      await initialized;
      try {
        if (path === '/local-api/recorder/config' && request.method === 'GET') {
          const config = await readConfig();
          const snapshot = await options.cameraMetadata().catch(() => ({ cameras: [] }));
          let topicsError = '';
          const graph = await discoveredTopics().catch((error) => { topicsError = error.message; return []; });
          const cameras = cameraTopics(config).map(({ serial, topic }) => {
            const camera = snapshot.cameras.find((entry) => entry.id === serial);
            return { serial, topic, online: camera?.online ?? false,
              width: camera?.width ?? 0, height: camera?.height ?? 0, inputFps: camera?.input_fps ?? 0 };
          });
          const topics = new Map(graph.map((entry) => [entry.name, { ...entry, camera: false, available: true }]));
          for (const camera of cameras) topics.set(camera.topic, { name: camera.topic,
            types: topics.get(camera.topic)?.types ?? ['sensor_msgs/msg/Image'], camera: true,
            available: topics.has(camera.topic) });
          json(response, 200, { saveDirectory: join(dataRoot, 'recordings'), cameras,
            topics: [...topics.values()].sort((a, b) => a.name.localeCompare(b.name)), topicsError,
            timestamp: timestampName(now()), timeZone: process.env.TZ || 'Europe/Berlin',
            syncToleranceMs: Number(process.env.RECORD_SYNC_TOLERANCE_MS || 5) });
        } else if (path === '/local-api/recorder/status' && request.method === 'GET') {
          json(response, 200, recordState(Number(url.searchParams.get('after') || 0)));
        } else if (path === '/local-api/recorder/start' && request.method === 'POST') {
          json(response, 200, await startRecording(request));
        } else if (path === '/local-api/recorder/stop' && request.method === 'POST') {
          await stopRecording(); json(response, 200, recordState());
        } else if (path === '/local-api/recorder/frame' && request.method === 'POST') {
          json(response, 200, await recordFrame(request));
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
