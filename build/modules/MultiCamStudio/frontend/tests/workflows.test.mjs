import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startMcs } from '../server/server.mjs';
import { timestampName } from '../server/timestamps.mjs';
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// Exercise the production HTTP workflow with process-boundary fixtures. Real
// image matching, bag storage and calibration mathematics have separate ROS tests.
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
  const recorder = await mock('bag-recorder', `import {mkdirSync,writeFileSync} from 'node:fs';
    const directory=process.argv[process.argv.indexOf('--output')+1];
    const topics=process.argv.slice(process.argv.indexOf('--topics')+1);
    mkdirSync(directory);writeFileSync(directory+'/data.mcap','bag data');
    console.log(JSON.stringify({event:'ready',capture_format:'rosbag2',topics,output_directory:directory}));
    process.on('SIGTERM',()=>{writeFileSync(directory+'/metadata.yaml','rosbag2_bagfile_information: {}');
      writeFileSync(directory+'/session.json',JSON.stringify({status:'complete',topics}));process.exit(0)});setInterval(()=>{},1000);`);
  const capture = await mock('capture', `import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
    const frame=process.argv[2]==='--frame',offset=frame?1:0;
    const config=JSON.parse(readFileSync(process.argv[2+offset]));
    const directory=process.argv[3+offset];
    if(config.__wait){process.on('SIGTERM',()=>process.exit(1));setInterval(()=>{},1000)}else{
    mkdirSync(directory);if(!frame)mkdirSync(directory+'/images');
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/wAAAABJRU5ErkJggg==','base64');
    for(const sn of config.serial_numbers)for(let i=1;i<=(frame?1:3);i++){
      if(config.__missingPng&&sn==='202'&&i===2)continue;
      const file=frame?'/cam'+sn+'.png':'/images/cam'+sn+'-'+String(i).padStart(4,'0')+'.png';
      writeFileSync(directory+file,config.__invalidPng?'not a PNG':png);
    }
    writeFileSync(directory+'/session.json',JSON.stringify({status:'complete',capture_format:'png',calibration_capture:!frame,frames:frame?1:3,width:160,height:120}));}`);
  const calibrator = await mock('calibrator', `import {writeFileSync,readFileSync,readdirSync} from 'node:fs';
    if(!process.argv[2].endsWith('/images')||readdirSync(process.argv[2]).filter(name=>name.endsWith('.png')).length!==6)process.exit(2);
    const config=JSON.parse(readFileSync(process.argv[3]));
    writeFileSync(config.savedir+'/Calibration160x120.json',JSON.stringify({main_cam_serial:config.main_cam_serial,CAMERAS:config.serial_numbers.map(sn=>({SerialNumber:sn,Intrinsic:[100,0,80,0,100,60,0,0,1],Distortion:[0,0,0,0,0],Extrinsic:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}))}));`);
  const validator = await mock('validator', `import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
    const config=JSON.parse(readFileSync(process.argv[2]));mkdirSync(process.argv[3]);
    writeFileSync(process.argv[3]+'/back_projeced3d.jpg','preview');
    writeFileSync(process.argv[3]+'/validation.json',JSON.stringify({passed:!config.__reject,points:10,mean_reprojection_error_px:config.__reject?20:0.2}));
    process.exit(config.__reject?1:0);`);
  const socket = createServer(); await new Promise((done) => socket.listen(0, done));
  const streamerPort = socket.address().port; await new Promise((done) => socket.close(done));
  let clock = 0;
  let frozenClock = null;
  const app = await startMcs({ port: 0, streamerPort, executable: preview, config: configPath, dist: root,
    dataRoot: data, bagRecorder: recorder, captureExecutable: capture, calibratorExecutable: calibrator,
    now: () => frozenClock ?? new Date(1795794000000 + clock++ * 1000),
    topicDiscovery: async () => [{ name: '/imu', types: ['sensor_msgs/msg/Imu'] }],
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
  const sources = await get('/local-api/recorder/config');
  assert.equal(sources.topics.filter(topic => topic.camera).length, 2);
  assert.ok(sources.topics.some(topic => topic.name === '/imu'));
  assert.equal((await post('/local-api/recorder/start', { topics: [] })).status, 400);
  const recording = await post('/local-api/recorder/start', { topics: ['/imu'] });
  assert.equal(recording.status, 200);
  assert.equal((await recording.json()).ready, true);
  assert.equal((await post('/local-api/recorder/start', { name: 'other' })).status, 400);
  assert.equal((await post('/local-api/calibration/run')).status, 400);
  const bagState = await get('/local-api/recorder/status');
  assert.deepEqual(bagState.session.topics, ['/imu']);
  assert.match(bagState.session.name, /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
  const frameResponse = await post('/local-api/recorder/frame');
  assert.equal(frameResponse.status, 200);
  const frame = await frameResponse.json();
  assert.match(frame.name, /^frame_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
  assert.ok((await readdir(frame.outputDirectory)).includes('cam101.png'));
  assert.ok((await get('/local-api/recorder/status')).recording);
  await post('/local-api/recorder/stop');
  assert.equal((await get('/local-api/recorder/status')).recording, false);
  assert.equal(JSON.parse(await readFile(join(bagState.session.outputDirectory, 'session.json'))).status, 'complete');
  frozenClock = new Date('2026-11-28T12:00:00Z');
  for (const prefix of ['', 'frame_']) {
    const existing = join(data, 'recordings', prefix + timestampName(frozenClock));
    await mkdir(existing);
    await writeFile(join(existing, 'keep.txt'), 'existing capture');
    const collision = await post('/local-api/recorder/' + (prefix ? 'frame' : 'start'));
    assert.equal(collision.status, 400);
    assert.match((await collision.json()).error, /next second/);
    assert.equal(await readFile(join(existing, 'keep.txt'), 'utf8'), 'existing capture');
  }
  frozenClock = null;
  assert.equal((await post('/local-api/recorder/start', { name: 'not-a-timestamp' })).status, 400);
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
  for (const broken of [{ __missingPng: true }, { __invalidPng: true }]) {
    await writeFile(configPath, JSON.stringify({ ...config, ...broken }));
    await post('/local-api/calibration/run');
    const incomplete = await finished();
    assert.equal(incomplete.result.success, false);
    assert.equal(incomplete.stages.capture, 'error');
    assert.equal(incomplete.stages.calibrate, 'pending');
    assert.match(incomplete.result.error, /calibration PNG/);
    assert.equal(await readFile(join(data, 'logs/Calibration160x120.json'), 'utf8'), published);
  }
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
  assert.equal((await post('/local-api/recorder/frame')).status, 400);
  assert.equal((await post('/local-api/calibration/cancel')).status, 200);
  assert.equal((await finished()).result.success, false);
  assert.equal(JSON.parse(await readFile(configPath)).__wait, true); // Mounted source is never rewritten.
});
