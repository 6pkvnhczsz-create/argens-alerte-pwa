import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeAdminUpstream,UPSTREAM_ADMIN_PAGE} from '../src/upstream-admin-test.js';
const now=Date.parse('2026-11-21T12:00:00Z');
const reading=(name,trend,age=10)=>({code:name,name,status:'current',trendCmH:trend,levelM:2,observedAt:new Date(now-age*60000).toISOString()});
test('admin-only summary filters stale stations and ranks rises',()=>{
 const x=summarizeAdminUpstream({upstream:[reading('A',15),reading('B',45),reading('C',-3),reading('D',99,100)],checkedAt:new Date(now).toISOString()},now);
 assert.equal(x.stations.length,3);assert.equal(x.rising,2);assert.equal(x.falling,1);assert.equal(x.fastest.name,'B');assert.equal(x.predictsArrivalTime,false);
});
test('missing upstream data does not imply stable river',()=>{
 const x=summarizeAdminUpstream({upstream:[]},now);assert.equal(x.status,'unavailable');assert.equal(x.stable,0);
});
test('admin test page does not send notifications',()=>{
 assert.match(UPSTREAM_ADMIN_PAGE,/Nur im geschützten Adminbereich/);
 assert.doesNotMatch(UPSTREAM_ADMIN_PAGE,/push_subscriptions|sendNotification|broadcastAdmin/);
});
