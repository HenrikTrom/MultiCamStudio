// Run with Playwright installed in a separate browser test environment.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", args: [
  '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
] });
try {
  const base = process.env.BASE_URL || 'http://127.0.0.1:5173';
  const page = await browser.newPage({ baseURL: base, viewport: { width: 1536, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  assert.equal(await page.title(), 'MultiCam Control Studio ROS2');
  assert.match(await page.locator('.brand').textContent(), /Control Studio ROS2/);
  await page.getByRole('heading', { name: 'Streamer', exact: true }).waitFor();
  // Software-only headless rendering should not spend the CPU on focus shaders.
  await page.locator('.focus-toggle input').uncheck();
  await page.waitForFunction(() => document.querySelectorAll('.camera-tile').length > 0);
  const count = await page.locator('.camera-tile').count();
  const playback = () => page.waitForFunction(() => {
    const videos = [...document.querySelectorAll('.camera-tile video')];
    return videos.length > 0 && videos.every((video) => video.videoWidth > 0 && video.readyState >= 2);
  }, undefined, { timeout: 30000 });
  await playback();
  await page.waitForFunction(() => [...document.querySelectorAll('video')].every(
    (video) => video.getVideoPlaybackQuality().totalVideoFrames > 5), undefined, { timeout: 15000 });
  const frames = await page.locator('video').evaluateAll((videos) => videos.map((video) => ({
    width: video.videoWidth, height: video.videoHeight, time: video.currentTime,
    decoded: video.getVideoPlaybackQuality().totalVideoFrames,
  })));
  assert.ok(frames.every((frame) => frame.decoded > 5), JSON.stringify(frames));
  const cameras = await (await page.request.get('/api/cameras')).json();
  assert.equal(cameras.configured_cameras, count);
  assert.equal(cameras.online_cameras, count);
  assert.ok(cameras.cameras.every((camera) => camera.input_fps > 0 && camera.stream_fps > 0));
  assert.equal(await page.getByRole('button', { name: 'HRSoc Recorder' }).count(), 0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Camera connections' }).waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /ROS domain/);
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  // Simulate one missing feed in the API while leaving physical cameras alone.
  await page.route('**/api/cameras', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    Object.assign(payload.cameras[0], { online: false, preview_active: false, input_fps: 0, stream_fps: 0 });
    payload.online_cameras--;
    await route.fulfill({ response, json: payload });
  });
  await page.locator('.camera-tile').first().getByText('Waiting for images', { exact: true }).waitFor();
  assert.match(await page.locator('.header-status strong').innerText(), new RegExp(`${count - 1} / ${count}`));
  await page.unroute('**/api/cameras');
  await playback();

  await page.getByRole('button', { name: 'Stop stream', exact: true }).click();
  await page.getByText('Preview service stopped', { exact: true }).waitFor();
  assert.equal((await page.request.get('/healthz')).status(), 200);
  assert.equal((await page.request.get('/api/cameras')).status(), 503);
  await page.getByRole('button', { name: 'Start stream', exact: true }).click();
  await playback();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/artifacts/mcs-streamer.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`PASS: MCS GUI, ${count} decoded camera videos, measured Hz, settings, offline recovery, Stop/Start`);
  console.log(JSON.stringify(frames));
} finally {
  await browser.close();
}
