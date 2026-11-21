import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyObservationFreshness} from './observation-freshness.mjs';
const now = Date.parse('2026-11-21T12:00:00.000Z');
const at = mins => now - mins * 60000;
test('freshness boundaries use observation time', () => {
  assert.equal(classifyObservationFreshness(at(15), {now}).status, 'current');
  assert.equal(classifyObservationFreshness(at(16), {now}).status, 'delayed');
  assert.equal(classifyObservationFreshness(at(30), {now}).status, 'delayed');
  assert.equal(classifyObservationFreshness(at(31), {now}).status, 'warning');
});
test('invalid or future timestamps never appear current', () => {
  for (const input of [null, '', 'not-a-date', NaN, now + 16*60000])
    assert.equal(classifyObservationFreshness(input, {now}).status, 'unavailable');
});
test('future timestamp within tolerated clock skew is current', () => {
  assert.equal(classifyObservationFreshness(now + 2*60000, {now}).status, 'current');
});
