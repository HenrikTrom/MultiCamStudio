import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let page, recordingStarted = false;
try {
  page = await browser.newPage({ baseURL: process.env.BASE_URL || 'http://127.0.0.1:5173', viewport: { width: 1536, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  assert.equal(await page.title(), 'MultiCam Control Studio ROS2');
  assert.match(await page.locator('.brand').textContent(), /Control Studio ROS2/);
  await page.locator('.focus-toggle input').uncheck();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await page.getByRole('heading', { name: 'Record', exact: true }).waitFor();
  const config = await (await page.request.get('/local-api/recorder/config')).json();
  await page.waitForFunction(() => [...document.querySelectorAll('.form-stack input')].some((input) => input.value.length > 0));
  const directory = config.saveDirectory.replace(/\/recordings$/, '/test/ros2-stage3-verification');
  await page.getByLabel('Recordings directory', { exact: true }).fill(directory);
  for (const topic of config.topics.filter((topic) => topic.camera)) {
    assert.equal(await page.getByRole('checkbox', { name: topic.name, exact: false }).isChecked(), true);
  }
  const selectedTopics = config.topics.filter((topic) => topic.camera).map((topic) => topic.name);
  const extra = config.topics.find((topic) => !topic.camera && (process.env.EXPECT_EXTRA_TOPIC ?
    topic.name === process.env.EXPECT_EXTRA_TOPIC : topic.name.endsWith('/imu')));
  if (process.env.EXPECT_EXTRA_TOPIC) assert.ok(extra, JSON.stringify(config));
  if (extra) {
    const checkbox = page.getByRole('checkbox', { name: extra.name, exact: false });
    assert.equal(await checkbox.isChecked(), false);
    await checkbox.check();
    selectedTopics.push(extra.name);
    if (selectedTopics.length > 2) {
      const removed = selectedTopics.shift();
      await page.getByRole('checkbox', { name: removed, exact: false }).uncheck();
    }
    // User selections must survive subsequent status/configuration polls.
    await page.waitForTimeout(1500);
    assert.equal(await checkbox.isChecked(), true);
  }
  await page.getByRole('button', { name: 'Start ROS bag', exact: true }).click();
  await page.getByRole('button', { name: 'Stop recording', exact: true }).waitFor({ timeout: 25000 });
  recordingStarted = true;
  await page.waitForTimeout(1500);
  const recording = await (await page.request.get('/local-api/recorder/status')).json();
  assert.equal(recording.recording, true);
  assert.equal(recording.ready, true);
  assert.deepEqual([...recording.session.topics].sort(), selectedTopics.sort());
  const frameResponse = page.waitForResponse((response) => response.url().endsWith('/local-api/recorder/frame') && response.request().method() === 'POST', { timeout: 25000 });
  await page.getByRole('button', { name: 'Record frame', exact: true }).click();
  const frameResult = await frameResponse;
  assert.equal(frameResult.status(), 200);
  const frame = await frameResult.json();
  await page.getByRole('paragraph').filter({ hasText: 'Latest frame:' }).getByText(frame.outputDirectory, { exact: true }).waitFor();
  const captured = await (await page.request.get('/local-api/recorder/status')).json();
  assert.equal(captured.frameSession.outputDirectory, frame.outputDirectory);
  assert.match(captured.frameSession.name, /^frame_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await page.getByRole('button', { name: 'Start ROS bag', exact: true }).waitFor();
  recordingStarted = false;
  const stopped = await (await page.request.get('/local-api/recorder/status')).json();
  assert.equal(stopped.recording, false);
  assert.equal(stopped.error, '');
  assert.ok(stopped.progress.message_count > 3);
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
  console.log('PASS: ROS2 branding, ROS bag Start/Stop, concurrent PNG frame, calibration controls/guide/3D view');
  console.log(JSON.stringify({ outputDirectory: stopped.session.outputDirectory, messages: stopped.progress.message_count, frameDirectory: captured.frameSession.outputDirectory }));
} finally {
  if (recordingStarted) await page.request.post('/local-api/recorder/stop', { data: {} }).catch(() => {});
  await browser.close();
}
