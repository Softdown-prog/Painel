#!/usr/bin/env node
// Dedicated network joining only the existing code MCP and Cloudflare tunnel.
// Default is read-only preview. No host firewall, DNS, Caddy or cloudflared config writes.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const EDGE_NETWORK='vps_code_mcp_edge';
export const MCP_CONTAINER='vps-code-mcp';
export const TUNNEL_CONTAINER='softload-panel-tunnel';
export const EDGE_ALIAS='code-mcp-bridge';
export const TUNNEL_ORIGIN='http://code-mcp-bridge:8789';

function assert(condition,message){
 if(!condition)throw Error(message);
}
export function verifyContainers(mcp,tunnel){
 assert(mcp?.Name==='/'+MCP_CONTAINER,'Container MCP fixo ausente ou com nome divergente');
 assert(mcp?.State?.Running===true,'Container MCP não está em execução');
 assert(mcp?.State?.Health?.Status==='healthy','Container MCP não está healthy');
 assert(mcp?.Config?.Labels?.['com.softdown.code-mcp.managed']==='true','Container MCP sem label de propriedade');
 assert(/^vps-code-mcp:[a-f0-9]{40}$/.test(mcp?.Config?.Image??''),'Imagem MCP diferente da instalação verificada');
 const ports=mcp?.HostConfig?.PortBindings?.['8789/tcp'];
 assert(Array.isArray(ports)&&ports.length===1&&ports[0].HostIp==='127.0.0.1'&&ports[0].HostPort==='8789',
   'Porta do MCP não está limitada ao loopback do host');
 assert(mcp?.HostConfig?.Privileged!==true,'MCP está em modo privilegiado');
 assert((mcp?.Mounts??[]).some(m=>m.Destination==='/run/secrets/code-mcp-token'&&m.RW===false),
   'MCP não possui o segredo montado em modo somente leitura');
 assert(tunnel?.Name==='/'+TUNNEL_CONTAINER,'Cloudflare Tunnel fixo ausente');
 assert(tunnel?.State?.Running===true,'Cloudflare Tunnel não está em execução');
 assert(/^cloudflare\/cloudflared(?::|@|$)/.test(tunnel?.Config?.Image??''),'Imagem inesperada no container do Tunnel');
 assert(Boolean(tunnel?.NetworkSettings?.Networks?.vps_panel_control),'Tunnel não participa da rede de controle esperada');
 assert(!(tunnel?.Mounts??[]).some(m=>m.Destination==='/var/run/docker.sock'),
   'Tunnel não pode ter acesso ao Docker socket');
}
export function verifyNetwork(network){
 if(!network)return;
 assert(network.Name===EDGE_NETWORK,'Nome de rede incompatível');
 assert(network.Internal===true&&network.Driver==='bridge','Rede não é uma bridge interna');
 assert(network.Labels?.['com.softdown.code-mcp.edge']==='true','Rede existente sem label de propriedade');
 const names=Object.values(network.Containers??{}).map(c=>c.Name);
 assert(names.every(name=>[MCP_CONTAINER,TUNNEL_CONTAINER].includes(name)),
   'Rede privada contém containers de outros projetos');
}
function hasContainer(network,name){
 return Object.values(network?.Containers??{}).some(c=>c.Name===name);
}
export function plan(mcp,tunnel,network){
 verifyContainers(mcp,tunnel);
 verifyNetwork(network);
 return {network:EDGE_NETWORK,internal:true,origin:TUNNEL_ORIGIN,
   attached:{mcp:hasContainer(network,MCP_CONTAINER),tunnel:hasContainer(network,TUNNEL_CONTAINER)},
   changes:!network||!hasContainer(network,MCP_CONTAINER)||!hasContainer(network,TUNNEL_CONTAINER),
   dnsConfigured:false,publicHttpsPublished:false};
}
function execDocker(args,{missingOk=false}={}){
 const process=spawnSync('docker',args,{encoding:'utf8',maxBuffer:1024*1024,timeout:20000});
 if(process.error)throw process.error;
 if(process.status!==0){
  if(missingOk&&process.status===1&&/no such (network|object|container)/i.test(process.stderr??''))return null;
  throw Error('Comando Docker falhou: '+args[0]+'; verifique registro privado do host');
 }
 return process.stdout.trim();
}
export function createEdgeManager({docker=execDocker}={}){
 const container=name=>JSON.parse(docker(['inspect','--type=container',name]))[0];
 const network=()=>{
  const raw=docker(['network','inspect',EDGE_NETWORK],{missingOk:true});
  return raw===null?null:JSON.parse(raw)[0];
 };
 const check=()=>plan(container(MCP_CONTAINER),container(TUNNEL_CONTAINER),network());
 const apply=()=>{
  let current=check();
  if(!current.changes)return {...current,changed:false};
  let created=false,attachedMcp=false,attachedTunnel=false;
  try{
   if(!network()){
    docker(['network','create','--driver','bridge','--internal',
      '--label','com.softdown.code-mcp.edge=true',EDGE_NETWORK]);
    created=true;
   }
   current=check(); // ownership verified after network creation
   if(!current.attached.mcp){
    docker(['network','connect','--alias',EDGE_ALIAS,EDGE_NETWORK,MCP_CONTAINER]);
    attachedMcp=true;
   }
   if(!current.attached.tunnel){
    docker(['network','connect',EDGE_NETWORK,TUNNEL_CONTAINER]);
    attachedTunnel=true;
   }
   const result=check();
   assert(result.attached.mcp&&result.attached.tunnel,'A rede não possui os dois serviços');
   return {...result,changed:true};
  }catch(e){
   if(attachedTunnel){try{docker(['network','disconnect',EDGE_NETWORK,TUNNEL_CONTAINER]);}catch{}}
   if(attachedMcp){try{docker(['network','disconnect',EDGE_NETWORK,MCP_CONTAINER]);}catch{}}
   if(created){try{docker(['network','rm',EDGE_NETWORK]);}catch{}}
   throw e;
  }
 };
 const rollback=()=>{
  const mcp=container(MCP_CONTAINER),tunnel=container(TUNNEL_CONTAINER);
  assert(mcp?.Name==='/'+MCP_CONTAINER&&mcp?.Config?.Labels?.['com.softdown.code-mcp.managed']==='true',
    'Container MCP não pertence a esta instalação');
  assert(tunnel?.Name==='/'+TUNNEL_CONTAINER&&
    /^cloudflare\/cloudflared(?::|@|$)/.test(tunnel?.Config?.Image??''),
    'Tunnel não pertence à instalação esperada');
  const net=network();
  verifyNetwork(net);
  if(!net)return {network:EDGE_NETWORK,changed:false};
  if(hasContainer(net,TUNNEL_CONTAINER))docker(['network','disconnect',EDGE_NETWORK,TUNNEL_CONTAINER]);
  if(hasContainer(net,MCP_CONTAINER))docker(['network','disconnect',EDGE_NETWORK,MCP_CONTAINER]);
  docker(['network','rm',EDGE_NETWORK]);
  return {network:EDGE_NETWORK,changed:true};
 };
 return {check,apply,rollback};
}
const called=process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1];
if(called){
 const mode=process.argv[2]??'--check',confirm=process.argv[3];
 const authorized=(mode==='--apply'&&confirm==='LINK:code-mcp')||
   (mode==='--rollback'&&confirm==='UNLINK:code-mcp');
 if(mode!=='--check'&&!authorized)throw Error('Ação exige confirmação literal LINK:code-mcp ou UNLINK:code-mcp');
 if(authorized&&process.getuid?.()!==0)throw Error('Mudanças exigem Shell administrativa root');
 const edge=createEdgeManager();
 const output=mode==='--check'?edge.check():mode==='--apply'?edge.apply():edge.rollback();
 process.stdout.write(JSON.stringify(output,null,2)+'\n');
}
