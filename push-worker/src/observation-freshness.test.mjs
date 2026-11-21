import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyObservationFreshness} from './observation-freshness.mjs';
const now = Date.parse('2026-11-21T12:00:00.000Z');
const at = mins => now - mins * 60000;
test('freshness boundaries use observation time', () => {
  assert.equal(classifyObservationFreshness(at(30), {now}).status, 'current');
  assert.equal(classifyObservationFreshness(at(61), {now}).status, 'delayed');
  assert.equal(classifyObservationFreshness(at(60), {now}).status, 'delayed');
  assert.equal(classifyObservationFreshness(at(61), {now}).status, 'warning');
});
test('invalid or future timestamps never appear current', () => {
  for (const input of [null, '', 'not-a-date', NaN, now + 16*60000])
    assert.equal(classifyObservationFreshness(input, {now}).status, 'unavailable');
});
test('future timestamp within tolerated clock skew is current', () => {
  assert.equal(classifyObservationFreshness(now + 2*60000, {now}).status, 'current');
});

test('status reflects actual newest observation rather than delivery timestamp', async () => {
  const {observationDataStatus} = await import('./observation-freshness.mjs');
  const result = {source:'vigicrues', transport:'github-actions', receivedAt:new Date(now).toISOString(), points:[{time:at(61),mm:5400}]};
  assert.deepEqual(observationDataStatus(result,{now}), {
    status:'warning',ageMinutes:61,observedAt:new Date(at(61)).toISOString(),
    source:'vigicrues',transport:'github-actions',hasUsableReading:true
  });
  assert.equal(observationDataStatus({points:[]},{now}).status,'unavailable');
});
