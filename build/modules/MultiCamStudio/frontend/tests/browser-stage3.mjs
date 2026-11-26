import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ baseURL: process.env.BASE_URL || 'http://127.0.0.1:5173', viewport: { width: 1536, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  assert.equal(await page.title(), 'MultiCam Control Studio ROS2');
  assert.match(await page.locator('.brand').textContent(), /Control Studio ROS2/);
  await page.locator('.focus-toggle input').uncheck();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await page.getByRole('heading', { name: 'Record', exact: true }).waitFor();
  const config = await (await page.request.get('/local-api/recorder/config')).json();
  await page.waitForFunction(() => [...document.querySelectorAll('.form-stack input')].some((input) => input.value.includes('/recordings')));
  const name = `ros2-stage3-browser-${Date.now()}`;
  const directory = config.saveDirectory.replace(/\/recordings$/, '/test/ros2-stage3-verification');
  await page.getByLabel('Session name', { exact: true }).fill(name);
  await page.getByLabel('Save directory', { exact: true }).fill(directory);
  await page.getByRole('button', { name: 'Start recording', exact: true }).click();
  await page.getByRole('button', { name: 'Stop recording', exact: true }).waitFor({ timeout: 25000 });
  await page.waitForTimeout(1500);
  const recording = await (await page.request.get('/local-api/recorder/status')).json();
  assert.equal(recording.recording, true);
  assert.equal(recording.ready, true);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor();
  const stopped = await (await page.request.get('/local-api/recorder/status')).json();
  assert.equal(stopped.recording, false);
  assert.equal(stopped.error, '');
  assert.ok(stopped.progress.frames > 3);
  await page.screenshot({ path: '/artifacts/mcs-ros2-record.png', fullPage: true });
  await page.getByRole('button', { name: 'Calibration', exact: true }).click();
  await page.getByRole('heading', { name: 'Calibration', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Run calibration', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.calibration-guide-gif')?.naturalWidth > 0);
  const available = (await page.request.head('/local-api/calibration/latest-json')).ok();
  if (available) {
    await page.getByRole('button', { name: '3D view', exact: true }).click();
    await page.getByRole('heading', { name: 'Camera field of view', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close 3D view', exact: true }).click();
  }
  await page.screenshot({ path: '/artifacts/mcs-ros2-calibration.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: ROS2 branding, live recording Start/Stop, calibration controls/guide/3D view');
  console.log(JSON.stringify({ outputDirectory: stopped.session.outputDirectory, frames: stopped.progress.frames, maxSkewNs: stopped.progress.max_skew_ns }));
} finally { await browser.close(); }
