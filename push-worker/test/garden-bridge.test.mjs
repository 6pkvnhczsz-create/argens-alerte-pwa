import test from 'node:test';
import assert from 'node:assert/strict';
import { runGardenBridge } from '../src/garden-bridge.mjs';

test('calls the internal Smart Garden RPC once on success', async () => {
  let calls = 0;
  const result = await runGardenBridge({
    SMART_GARDEN_MONITOR: { async run() {calls++; return {ok:true,checkedAt:'2026-11-22T14:00:00Z'};}}
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {ok:true,checkedAt:'2026-11-22T14:00:00Z'});
});

test('returns a failure result and never throws when the target is unavailable', async () => {
  const oldError = console.error;
  console.error = () => {};
  try {
    const missing = await runGardenBridge({});
    const failed = await runGardenBridge({
      SMART_GARDEN_MONITOR: {async run(){throw Error('CloudRain API unavailable');}}
    });
    assert.equal(missing.ok, false);
    assert.equal(failed.ok, false);
  } finally {console.error = oldError;}
});

test('rejects an unsuccessful RPC result without affecting caller', async () => {
  const oldError = console.error;
  console.error = () => {};
  try {
    const result = await runGardenBridge({
      SMART_GARDEN_MONITOR: {async run(){return {ok:false};}}
    });
    assert.equal(result.ok, false);
  } finally {console.error = oldError;}
});
