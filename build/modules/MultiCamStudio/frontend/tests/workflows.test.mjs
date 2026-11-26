import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startMcs } from '../server/server.mjs';
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// Exercise the production HTTP workflow with process-boundary fixtures. Real
// image matching, encoding and calibration mathematics have separate ROS tests.
test('recording lifecycle and calibration publication, failure, exclusivity, cancellation', { timeout: 30000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'mcs-workflows-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data'); await mkdir(data);
  const configPath = join(root, 'settings.json');
  const config = { serial_numbers: ['101', '202'], main_cam_serial: '101', savedir: join(data, 'logs'),
    pattern_size_first: 11, pattern_size_second: 7, charuco_params_dict: 0,
    charuco_params_marker_border_pixel: 1, charuco_params_border_size: 1,
    charuco_params_square_size: 80, charuco_params_marker_to_square_ratio: 0.75 };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(join(root, 'index.html'), 'MCS ROS2');
  const mock = async (name, code) => {
    const path = join(root, name + '.mjs');
    await writeFile(path, `#!${process.execPath}\n` + code, { mode: 0o755 });
    return path;
  };
  const preview = await mock('preview', `import {createServer} from 'node:http';
    const server=createServer((request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(request.url==='/api/cameras'?{cameras:[{id:'101',online:true,width:160,height:120,input_fps:60}]}:{status:'ok'}))});
    server.listen(Number(process.env.STREAMER_PORT),'127.0.0.1');
    process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0))});`);
  const recorder = await mock('recorder', `import {mkdirSync,writeFileSync} from 'node:fs';
    mkdirSync(process.argv[3]);console.log(JSON.stringify({event:'ready',cameras:2,width:160,height:120}));
    console.log(JSON.stringify({event:'progress',frames:3,width:160,height:120,dropped_frames:[0,0]}));
    process.on('SIGTERM',()=>{writeFileSync(process.argv[3]+'/session.json',JSON.stringify({status:'complete',frames:3}));process.exit(0)});setInterval(()=>{},1000);`);
  const capture = await mock('capture', `import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
    const config=JSON.parse(readFileSync(process.argv[2]));
    if(config.__wait){process.on('SIGTERM',()=>process.exit(1));setInterval(()=>{},1000)}else{
    mkdirSync(process.argv[3]);mkdirSync(process.argv[3]+'/images');
    writeFileSync(process.argv[3]+'/session.json',JSON.stringify({status:'complete',frames:3,width:160,height:120}));}`);
  const calibrator = await mock('calibrator', `import {writeFileSync,readFileSync} from 'node:fs';
    const config=JSON.parse(readFileSync(process.argv[3]));
    writeFileSync(config.savedir+'/Calibration160x120.json',JSON.stringify({main_cam_serial:config.main_cam_serial,CAMERAS:config.serial_numbers.map(sn=>({SerialNumber:sn,Intrinsic:[100,0,80,0,100,60,0,0,1],Distortion:[0,0,0,0,0],Extrinsic:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}))}));`);
  const validator = await mock('validator', `import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
    const config=JSON.parse(readFileSync(process.argv[2]));mkdirSync(process.argv[3]);
    writeFileSync(process.argv[3]+'/back_projeced3d.jpg','preview');
    writeFileSync(process.argv[3]+'/validation.json',JSON.stringify({passed:!config.__reject,points:10,mean_reprojection_error_px:config.__reject?20:0.2}));
    process.exit(config.__reject?1:0);`);
  const socket = createServer(); await new Promise((done) => socket.listen(0, done));
  const streamerPort = socket.address().port; await new Promise((done) => socket.close(done));
  const app = await startMcs({ port: 0, streamerPort, executable: preview, config: configPath, dist: root,
    dataRoot: data, recorderExecutable: recorder, captureExecutable: capture, calibratorExecutable: calibrator,
    python: process.execPath, validator });
  context.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (path) => (await fetch(base + path)).json();
  const post = async (path, values = {}) => fetch(base + path, { method: 'POST', body: JSON.stringify(values) });
  const finished = async () => {
    const deadline = Date.now() + 10000;
    while (true) {
      const state = await get('/local-api/calibration/status');
      if (!state.running) return state;
      assert.ok(Date.now() < deadline); await pause(50);
    }
  };
  assert.equal((await post('/local-api/recorder/start', { name: '..' })).status, 400);
  const recording = await post('/local-api/recorder/start', { name: 'sample' });
  assert.equal(recording.status, 200);
  assert.equal((await recording.json()).ready, true);
  assert.equal((await post('/local-api/recorder/start', { name: 'other' })).status, 400);
  assert.equal((await post('/local-api/calibration/run')).status, 400);
  await post('/local-api/recorder/stop');
  assert.equal((await get('/local-api/recorder/status')).recording, false);
  assert.equal(JSON.parse(await readFile(join(data, 'recordings/sample/session.json'))).status, 'complete');
  assert.equal((await post('/local-api/recorder/start', { name: 'sample' })).status, 400);
  assert.equal((await post('/local-api/recorder/start', { name: 'bad', saveDirectory: root })).status, 400);
  for (let index = 0; index < 2; index++) {
    assert.equal((await post('/local-api/calibration/run')).status, 202);
    const state = await finished();
    assert.equal(state.result.success, true, JSON.stringify(state));
    assert.equal(state.result.resultAvailable, true);
    assert.deepEqual(Object.values(state.stages), ['success', 'success', 'success']);
  }
  const published = await readFile(join(data, 'logs/Calibration160x120.json'), 'utf8');
  assert.equal((await readdir(join(data, 'logs/archive'))).length, 1);
  assert.equal((await fetch(base + '/local-api/calibration/result')).status, 200);
  assert.equal((await fetch(base + '/local-api/calibration/latest-json', { method: 'HEAD' })).status, 200);
  await writeFile(configPath, JSON.stringify({ ...config, __reject: true }));
  await post('/local-api/calibration/run');
  const failed = await finished();
  assert.equal(failed.result.success, false);
  assert.equal(failed.result.resultAvailable, true);
  assert.equal(failed.stages.validate, 'error');
  assert.equal(await readFile(join(data, 'logs/Calibration160x120.json'), 'utf8'), published);
  assert.equal((await readdir(join(data, 'logs/archive'))).length, 1);
  await writeFile(configPath, JSON.stringify({ ...config, __wait: true }));
  await post('/local-api/calibration/run');
  await pause(100);
  assert.equal((await post('/local-api/recorder/start', { name: 'blocked' })).status, 400);
  assert.equal((await post('/local-api/calibration/cancel')).status, 200);
  assert.equal((await finished()).result.success, false);
  assert.equal(JSON.parse(await readFile(configPath)).__wait, true); // Mounted source is never rewritten.
});
