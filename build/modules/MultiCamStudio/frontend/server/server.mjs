import { createWorkflows } from './workflows.mjs';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};

export async function startMcs(options = {}) {
  const port = options.port ?? Number(process.env.PORT || 5173);
  const streamerPort = options.streamerPort ?? Number(process.env.STREAMER_PORT || 8080);
  if (port === streamerPort) throw new Error('PORT and STREAMER_PORT must be different');
  const executable = options.executable ?? process.env.ROS_STREAMER_EXECUTABLE ??
    '/opt/mcs/ros2/lib/ros2_multicam_interface/camera_tab_ros2_web_streamer';
  const dist = resolve(options.dist ?? resolve(dirname(fileURLToPath(import.meta.url)), '../dist'));
  const config = options.config ?? process.env.CAMERA_CALIBRATION_FILE ??
    '/home/docker/workspace/cfg/CameraCalibrationSettings.json';
  const workflows = createWorkflows({ ...options, config, cameraMetadata: async () => {
    const response = await fetch(`http://127.0.0.1:${streamerPort}/api/cameras`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('Preview service unavailable');
    return response.json();
  } });
  const logs = [];
  let nextId = 1;
  let child = null;
  let wanted = true;
  let closing = false;
  let starting = null;
  let stopping = null;
  let retryTimer;
  const log = (stream, message) => {
    logs.push({ id: nextId++, stream, message });
    if (logs.length > 2000) logs.splice(0, logs.length - 2000);
    (stream === 'stderr' ? process.stderr : process.stdout).write(`[streamer] ${message}\n`);
  };
  const healthy = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    try {
      const result = await fetch(`http://127.0.0.1:${streamerPort}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      await result.arrayBuffer();
      return result.ok;
    } catch { return false; }
  };
  const start = () => {
    wanted = true;
    if (starting) return starting;
    starting = (async () => {
      if (stopping) await stopping;
      if (await healthy()) return;
      if (closing) throw new Error('MCS is shutting down');
      if (!child) {
        log('stdout', 'Starting ROS 2 preview service');
        const current = spawn(executable, [], {
          env: { ...process.env, STREAMER_PORT: String(streamerPort), CAMERA_CALIBRATION_FILE: config,
            STREAMER_BIND_ADDRESS: '127.0.0.1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child = current;
        for (const stream of ['stdout', 'stderr']) {
          createInterface({ input: current[stream] }).on('line', (line) => log(stream, line));
        }
        current.once('error', (error) => log('stderr', error.message));
        current.once('close', (code, signal) => {
          if (child === current) child = null;
          log(code === 0 || signal === 'SIGTERM' ? 'stdout' : 'stderr',
            `Preview service exited (${signal ?? code})`);
          if (wanted && !closing) {
            retryTimer = setTimeout(() => void start().catch((error) => log('stderr', error.message)), 2000);
          }
        });
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await healthy()) return;
        if (!wanted || !child) throw new Error('Preview service could not start; see camera service logs');
        await delay(100);
      }
      throw new Error('Preview service did not become ready; see camera service logs');
    })().finally(() => { starting = null; });
    return starting;
  };
  const stop = () => {
    wanted = false;
    clearTimeout(retryTimer);
    if (stopping) return stopping;
    stopping = (async () => {
      const current = child;
      if (!current) return;
      await new Promise((done) => {
        const timeout = setTimeout(() => current.kill('SIGKILL'), 6000);
        current.once('close', () => { clearTimeout(timeout); done(); });
        current.kill('SIGTERM');
      });
    })().finally(() => { stopping = null; });
    return stopping;
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      if (path === '/healthz' && request.method === 'GET') {
        return json(response, 200, { status: 'ok', streaming: await healthy() });
      }
      if (path === '/local-api/camera-stream/status' && request.method === 'GET') {
        const after = Number(url.searchParams.get('after') || 0);
        return json(response, 200, { streaming: await healthy(), logs: logs.filter((entry) => entry.id > after) });
      }
      if (path === '/local-api/camera-stream/start' && request.method === 'POST') {
        await start();
        return json(response, 200, { streaming: true });
      }
      if (path === '/local-api/camera-stream/stop' && request.method === 'POST') {
        await stop();
        return json(response, 200, { streaming: false });
      }
      if (path === '/local-api/config' && request.method === 'GET') {
        const calibration = JSON.parse(await readFile(config, 'utf8'));
        return json(response, 200, { calibration, ros: {
          domain: process.env.ROS_DOMAIN_ID || '0',
          topicTemplate: process.env.ROS_IMAGE_TOPIC_TEMPLATE || '/grasshopper/camera_{serial}/image_raw',
          previewLimit: 30, configFile: config,
        } });
      }
      if (await workflows.handle(request, response, path, url)) return;
      if (path.startsWith('/local-api/')) {
        return json(response, 501, { error: 'This feature is not available in the ROS 2 application yet.' });
      }
      if (path.startsWith('/api/')) {
        if (request.method !== 'GET') return json(response, 405, { error: 'Method not allowed' });
        const upstream = httpRequest({ hostname: '127.0.0.1', port: streamerPort,
          path: request.url, method: 'GET' }, (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.on('error', () => response.destroy());
          incoming.pipe(response);
        });
        // Streams remain open indefinitely; only their initial headers time out.
        const timeout = setTimeout(() => upstream.destroy(new Error('Preview service timed out')), 5000);
        upstream.once('response', () => clearTimeout(timeout));
        upstream.once('error', () => {
          clearTimeout(timeout);
          if (!response.headersSent) json(response, 503, { error: 'Preview service is stopped or starting' });
          else response.destroy();
        });
        response.once('close', () => upstream.destroy());
        upstream.end();
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json(response, 405, { error: 'Method not allowed' });
      }
      let file = resolve(dist, `.${decodeURIComponent(path)}`);
      if (file !== dist && !file.startsWith(dist + sep)) return json(response, 404, { error: 'Not found' });
      let details = await stat(file).catch(() => null);
      if (!details?.isFile()) {
        if (extname(path)) return json(response, 404, { error: 'Not found' });
        file = resolve(dist, 'index.html');
        details = await stat(file);
      }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
        '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
      response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        'Content-Length': details.size, 'Cache-Control': path.startsWith('/assets/') ?
          'public, max-age=31536000, immutable' : 'no-cache' });
      if (request.method === 'HEAD') return response.end();
      createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch (error) {
      if (!response.headersSent) json(response, 500, { error: error.message });
      else response.destroy();
    }
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, options.host ?? '0.0.0.0', done);
  });
  console.log(`MultiCamStudio GUI: http://localhost:${server.address().port}`);
  void start().catch((error) => log('stderr', error.message));
  return { server, start, stop, close: async () => {
    closing = true;
    await workflows.close();
    await stop();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  } };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const app = await startMcs();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
