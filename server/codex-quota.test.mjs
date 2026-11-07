import test from 'node:test';
import assert from 'node:assert/strict';
import {availablePercent,quotaCountdown} from '../angular/src/codex-quota.ts';
const quota=(usedPercent,resetsAt)=>({usedPercent,windowDurationMins:300,resetsAt});
test('remaining percentage uses only authenticated backend percentages',()=>{
 assert.equal(availablePercent(quota(27,null)),73);
 assert.equal(availablePercent(quota(0,null)),100);
 assert.equal(availablePercent(quota(100,null)),0);
 assert.equal(availablePercent(quota(null,null)),null);
 assert.equal(availablePercent(quota(-1,null)),null);
 assert.equal(availablePercent(quota(101,null)),null);
});
test('countdown never pretends a reached reset has already refreshed the quota',()=>{
 const now=1800000000000;
 assert.equal(quotaCountdown(quota(27,Math.floor(now/1000)+2*86400+3660),now),'2d 1h 1min restantes');
 assert.equal(quotaCountdown(quota(27,Math.floor(now/1000)+5*3600),now),'5h 0min restantes');
 assert.equal(quotaCountdown(quota(27,Math.floor(now/1000)+34),now),'1min restantes');
 assert.match(quotaCountdown(quota(27,Math.floor(now/1000)-1),now),/aguardando atualização/);
 assert.equal(quotaCountdown(quota(27,null),now),'Prazo não informado');
});
