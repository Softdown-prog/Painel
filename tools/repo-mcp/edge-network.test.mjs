import test from 'node:test';
import assert from 'node:assert/strict';
import {
 createEdgeManager,plan,verifyContainers,verifyNetwork,EDGE_NETWORK,MCP_CONTAINER,TUNNEL_CONTAINER,TUNNEL_ORIGIN
} from './edge-network.mjs';

function fixtures(){
 const mcp={
  Name:'/vps-code-mcp',State:{Running:true,Health:{Status:'healthy'}},
  Config:{Image:'vps-code-mcp:'+'a'.repeat(40),Labels:{'com.softdown.code-mcp.managed':'true'}},
  HostConfig:{Privileged:false,PortBindings:{'8789/tcp':[{HostIp:'127.0.0.1',HostPort:'8789'}]}},
  Mounts:[{Destination:'/run/secrets/code-mcp-token',RW:false}]
 };
 const tunnel={
  Name:'/softload-panel-tunnel',State:{Running:true},
  Config:{Image:'cloudflare/cloudflared:latest'},
  NetworkSettings:{Networks:{vps_panel_control:{}}},Mounts:[]
 };
 return {mcp,tunnel};
}
function mockDocker(initial=null){
 const {mcp,tunnel}=fixtures();
 let net=initial,commands=[];
 const docker=(args,{missingOk=false}={})=>{
  commands.push(args);
  if(args[0]==='inspect')return JSON.stringify([args[2]===MCP_CONTAINER?mcp:tunnel]);
  if(args[0]==='network'&&args[1]==='inspect')return net?JSON.stringify([net]):null;
  if(args[0]==='network'&&args[1]==='create'){
   if(net)throw Error('network already exists');
   net={Name:EDGE_NETWORK,Internal:true,Driver:'bridge',
    Labels:{'com.softdown.code-mcp.edge':'true'},Containers:{}};
   return EDGE_NETWORK;
  }
  if(args[0]==='network'&&args[1]==='connect'){
   const name=args.at(-1);
   net.Containers[name]={Name:name};
   return '';
  }
  if(args[0]==='network'&&args[1]==='disconnect'){
   delete net.Containers[args.at(-1)];
   return '';
  }
  if(args[0]==='network'&&args[1]==='rm'){
   if(Object.keys(net.Containers).length)throw Error('network not empty');
   net=null;
   return '';
  }
  throw Error('unexpected Docker command: '+args.join(' '));
 };
 return {docker,commands,getNetwork:()=>net};
}
test('dry-run never changes Docker; fixed origin and private bridge',()=>{
 const f=mockDocker(),manager=createEdgeManager({docker:f.docker});
 const result=manager.check();
 assert.equal(result.origin,TUNNEL_ORIGIN);
 assert.equal(result.changes,true);
 assert.equal(result.internal,true);
 assert.equal(result.publicHttpsPublished,false);
 assert.equal(f.commands.filter(c=>c.includes('create')||c.includes('connect')).length,0);
});
test('apply connects only two designated containers, is idempotent and reversible',()=>{
 const f=mockDocker(),manager=createEdgeManager({docker:f.docker});
 const result=manager.apply();
 assert.equal(result.changed,true);
 assert.equal(result.attached.mcp,true);
 assert.equal(result.attached.tunnel,true);
 assert.equal(f.getNetwork().Internal,true);
 assert.equal(f.commands.filter(c=>c[0]==='network'&&c[1]==='connect').length,2);
 const after=manager.apply();
 assert.equal(after.changed,false);
 assert.equal(f.commands.filter(c=>c[0]==='network'&&c[1]==='connect').length,2);
 const reset=manager.rollback();
 assert.equal(reset.changed,true);
 assert.equal(f.getNetwork(),null);
 const again=manager.rollback();
 assert.equal(again.changed,false);
});
test('never uses an existing network belonging to a different project',()=>{
 const f=mockDocker({Name:EDGE_NETWORK,Internal:true,Driver:'bridge',
  Labels:{'other':'true'},Containers:{}});
 assert.throws(()=>createEdgeManager({docker:f.docker}).apply(),/sem label/);
 assert.equal(f.commands.some(c=>c.includes('connect')),false);
});
test('never joins a network with third-party containers',()=>{
 const f=mockDocker({Name:EDGE_NETWORK,Internal:true,Driver:'bridge',
  Labels:{'com.softdown.code-mcp.edge':'true'},Containers:{foreign:{Name:'vps-postgres'}}});
 assert.throws(()=>createEdgeManager({docker:f.docker}).apply(),/outros projetos/);
 assert.equal(f.commands.some(c=>c.includes('connect')),false);
});
test('rejects unsafe MCP and tunnel status or unexpected public ports',()=>{
 const {mcp,tunnel}=fixtures();
 verifyContainers(mcp,tunnel);
 mcp.HostConfig.PortBindings['8789/tcp'][0].HostIp='0.0.0.0';
 assert.throws(()=>verifyContainers(mcp,tunnel),/loopback/);
 mcp.HostConfig.PortBindings['8789/tcp'][0].HostIp='127.0.0.1';
 tunnel.Config.Image='node:latest';
 assert.throws(()=>verifyContainers(mcp,tunnel),/Imagem inesperada/);
});
test('network must be internal and owned',()=>{
 assert.throws(()=>verifyNetwork({Name:EDGE_NETWORK,Internal:false,Driver:'bridge',
  Labels:{'com.softdown.code-mcp.edge':'true'},Containers:{}}),/bridge interna/);
});
