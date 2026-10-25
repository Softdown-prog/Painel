import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSshTerminalRoute } from './terminal-ssh.ts';

function client(sessionId = 'browser-one', execute = async command => ({
  exitCode: 0, output: 'executado: ' + command, truncated: false, timedOut: false
})) {
  const executions = [];
  const send = (_res, status, data) => { clientResult = { status, data }; };
  let clientResult;
  async function call(path, method = 'GET', body = {}, options = {}) {
    clientResult = undefined;
    const recognized = await handleSshTerminalRoute({url:path,method}, {}, {
      send, sessionId, enabled:true, body: async () => body,
      verifyPassword: password => password === 'secret-test-password',
      execute: async command => {executions.push(command);return execute(command);},
      ...options
    });
    assert.equal(recognized, true);
    return clientResult;
  }
  return {call,executions};
}
test('SSH Linux terminal is disabled by default and has no command execution without opt-in', async() => {
  let response;
  const matched=await handleSshTerminalRoute({method:'POST',url:'/terminal/ssh/exec'}, {}, {
    send: (_res,status,data)=>{response={status,data};}, enabled:false,
    sessionId:'t', body:async()=>({command:'uptime',token:'hi'}), verifyPassword:()=>true
  });
  assert.equal(matched,true);assert.equal(response.status,403);
});
test('SSH Linux terminal demands fresh admin password unlock and session-specific token',async()=>{
  const c=client();
  assert.equal((await c.call('/terminal/ssh/exec','POST',{command:'uptime',token:'bad'})).status,403);
  assert.equal((await c.call('/terminal/ssh/unlock','POST',{password:'bad'})).status,403);
  const approved=await c.call('/terminal/ssh/unlock','POST',{password:'secret-test-password'});
  assert.equal(approved.status,200);assert.match(approved.data.token,/^[a-f0-9]{64}$/);
  assert.equal((await c.call('/terminal/ssh/status')).data.unlocked,true);
  const result=await c.call('/terminal/ssh/exec','POST',{command:'uptime',token:approved.data.token});
  assert.equal(result.status,200);assert.equal(result.data.output,'executado: uptime');
  assert.deepEqual(c.executions,['uptime']);
  const other=client('browser-two');
  assert.equal((await other.call('/terminal/ssh/exec','POST',{command:'uptime',token:approved.data.token})).status,403);
  assert.equal(other.executions.length,0);
  assert.equal((await c.call('/terminal/ssh/lock','POST')).status,200);
  assert.equal((await c.call('/terminal/ssh/exec','POST',{command:'uptime',token:approved.data.token})).status,403);
});
test('SSH executor denies oversized or control-character commands without forwarding them',async()=>{
  const c=client('browser-validation');
  const auth=(await c.call('/terminal/ssh/unlock','POST',{password:'secret-test-password'})).data.token;
  for(const command of ['z'.repeat(601),'line\u0000cmd',' leading-space','trailing-space ']){
    assert.equal((await c.call('/terminal/ssh/exec','POST',{command,token:auth})).status,400);
  }
  assert.equal(c.executions.length,0);
});
