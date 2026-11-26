import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startMcs } from '../server/server.mjs';

const waitFor = async (check) => {
  const deadline = Date.now() + 12000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'Timed out');
    await new Promise((done) => setTimeout(done, 100));
  }
};

test('GUI startup, stream proxy, stop/start, crash recovery and read-only configuration', { timeout: 25000 }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcs-web-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<div id="root">MCS GUI</div>');
  await writeFile(join(directory, 'assets/main.js'), 'console.log("MCS")');
  const config = join(directory, 'calibration.json');
  await writeFile(config, JSON.stringify({ serial_numbers: ['123'] }));
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const streamerPort = socket.address().port;
  await new Promise((done) => socket.close(done));
  const executable = join(directory, 'preview.mjs');
  await writeFile(executable, `#!${process.execPath}
import { createServer } from 'node:http';
const server = createServer((request, response) => {
  if (request.url === '/api/crash') { response.end('crashing'); setTimeout(() => process.exit(2), 10); return; }
  if (request.url.endsWith('/stream')) {
    response.writeHead(200, {'Content-Type': 'application/x-flir-fmp4'});
    response.write(Buffer.from([1,0,0,0,1,0,0,0,0,0,0,0,0,42]));
    const timer=setInterval(() => response.write(Buffer.from([2,0,0,0,1,0,0,0,0,0,0,0,1,43])),30);
    response.on('close',() => clearInterval(timer)); return;
  }
  response.writeHead(200, {'Content-Type':'application/json'});
  response.end(JSON.stringify(request.url === '/api/cameras' ? {cameras:[{id:'123',online:true,input_fps:60,stream_fps:30}]} : {status:'ok'}));
});
server.listen(Number(process.env.STREAMER_PORT),'127.0.0.1');
console.log('mock preview ready');
process.on('SIGTERM', () => {server.closeAllConnections();server.close(() => process.exit(0));});
`, { mode: 0o755 });
  const app = await startMcs({ port: 0, streamerPort, executable, config, dist: directory, host: '127.0.0.1' });
  context.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (path) => (await fetch(base + path)).json();
  const post = async (path) => fetch(base + path, { method: 'POST' });
  assert.match(await (await fetch(base)).text(), /MCS GUI/);
  const asset = await fetch(base + '/assets/main.js');
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(base + '/assets/missing.js')).status, 404);
  assert.equal((await fetch(base + '/..%2foutside.txt')).status, 404);
  await waitFor(async () => (await get('/healthz')).streaming);
  assert.equal((await get('/api/cameras')).cameras[0].input_fps, 60);
  const stream = await fetch(base + '/api/cameras/0/stream');
  assert.equal(stream.headers.get('content-type'), 'application/x-flir-fmp4');
  const reader = stream.body.getReader();
  assert.equal((await reader.read()).value[0], 1);
  await reader.cancel();
  assert.deepEqual((await get('/local-api/config')).calibration.serial_numbers, ['123']);
  assert.equal((await post('/local-api/recorder/start')).status, 400);
  assert.equal((await post('/local-api/camera-stream/stop')).status, 200);
  assert.equal((await get('/healthz')).streaming, false);
  assert.match(await (await fetch(base)).text(), /MCS GUI/);
  assert.equal((await fetch(base + '/api/cameras')).status, 503);
  assert.equal((await post('/local-api/camera-stream/start')).status, 200);
  assert.equal((await get('/healthz')).streaming, true);
  await fetch(base + '/api/crash');
  await waitFor(async () => (await get('/local-api/camera-stream/status')).logs.some((entry) => entry.message.includes('exited (2)')));
  await waitFor(async () => (await get('/healthz')).streaming);
  const logs = (await get('/local-api/camera-stream/status')).logs;
  assert.ok(logs.some((entry) => entry.message.includes('mock preview ready')));
  assert.deepEqual((await get(`/local-api/camera-stream/status?after=${logs.at(-1).id}`)).logs, []);
});
