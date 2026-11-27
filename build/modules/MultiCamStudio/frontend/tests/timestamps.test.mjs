import assert from 'node:assert/strict';
import test from 'node:test';
import { timestampName } from '../server/timestamps.mjs';

test('recording names use local 24-hour timestamps with seconds and no random suffix', () => {
  assert.equal(timestampName(new Date('2026-11-27T15:56:23.508Z'), 'Europe/Berlin'), '2026-11-27-16-56-23');
  assert.equal(timestampName(new Date('2026-07-01T23:02:03Z'), 'Europe/Berlin'), '2026-07-02-01-02-03');
  assert.equal(timestampName(new Date('2026-11-27T00:00:00Z'), 'UTC'), '2026-11-27-00-00-00');
});
