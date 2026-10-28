import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSshTerminalRoute } from './terminal-ssh.ts';

function client(execute = async command => ({
  exitCode: 0, output: 'executado: ' + command, truncated: false, timedOut: false
})) {
  const executions = [];
  const send = (_res, status, data) => { clientResult = { status, data }; };
  let clientResult;
  async function call(path, method = 'GET', body = {}, options = {}) {
    clientResult = undefined;
    const recognized = await handleSshTerminalRoute({url:path,method}, {}, {
      send, enabled:true, body: async () => body,
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
    body:async()=>({command:'uptime'})
  });
  assert.equal(matched,true);assert.equal(response.status,403);
});
test('SSH Linux terminal executes with the already authenticated API session and no second password',async()=>{
  const c=client();
  const status=await c.call('/terminal/ssh/status');
  assert.equal(status.status,200);
  assert.equal(status.data.configured,true);
  assert.equal(Object.hasOwn(status.data,'expiresInSeconds'),false);
  const result=await c.call('/terminal/ssh/exec','POST',{command:'uptime'});
  assert.equal(result.status,200);assert.equal(result.data.output,'executado: uptime');
  assert.deepEqual(c.executions,['uptime']);
  assert.equal(await handleSshTerminalRoute({url:'/terminal/ssh/unlock',method:'POST'}, {}, {
    send:()=>{},body:async()=>({password:'unused'}),enabled:true,execute:async()=>result.data
  }),false);
});
test('SSH executor denies oversized or control-character commands without forwarding them',async()=>{
  const c=client();
  for(const command of ['z'.repeat(601),'line\u0000cmd',' leading-space','trailing-space ']){
    assert.equal((await c.call('/terminal/ssh/exec','POST',{command})).status,400);
  }
  assert.equal((await c.call('/terminal/ssh/exec','POST',{command:'uptime',token:'legacy'})).status,400);
  assert.equal((await c.call('/terminal/ssh/exec','POST',{command:'uptime',password:'secret'})).status,400);
  assert.equal(c.executions.length,0);
});
