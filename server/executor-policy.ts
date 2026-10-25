export type Inspect = { Id?: string; Name?: string; Config?: { Labels?: Record<string,string> }; State?: { Running?: boolean; Status?: string } };
export type Decision = { ok: boolean; reason: string; filterList?: boolean; name?: string; targetId?: string };
const owner='com.softload.panel.managed', slugLabel='com.softload.panel.slug';
const services=new Set(['softload-vps-app-1','softload-vps-agent-1','softload-vps-sandbox-1','softload-vps-embeddings-1']);
const monitor=new Set(['softload-caddy','softload-portainer']);
const slots=/^softload-(app|candidate|backup)-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const ram=new Set([128,256,512,768,1024].map(x=>x*1048576));
const cpus=new Set([250000000,500000000,1000000000,2000000000]);
const denied=(reason:string):Decision=>({ok:false,reason});
const approved=(name?:string):Decision=>({ok:true,reason:'allowlisted',name});
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).sort().join(',')===expected.sort().join(',');
export function validCreate(name:string,input:unknown,images:string[]):boolean{
 const slot=/^softload-(app|candidate)-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(name);
 if(!slot||slot[2].length>40||!object(input)||!keys(input,['Image','User','Labels','HostConfig'])||!object(input.Labels)||!object(input.HostConfig)||input.User!=='65534:65534')return false;
 const labels=input.Labels,host=input.HostConfig;
 if(labels[owner]!=='true'||labels[slugLabel]!==slot[2])return false;
 if(slot[1]==='app'){
   if(!keys(labels,[owner,slugLabel])||typeof input.Image!=='string'||!images.includes(input.Image))return false;
 }else{
   if(!keys(labels,[owner,slugLabel,'com.softload.panel.repository','com.softload.panel.revision','com.softload.panel.release-role'])||
     labels['com.softload.panel.release-role']!=='candidate'|| !/^[a-f0-9]{40}$/.test(String(labels['com.softload.panel.revision']))||
     !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(labels['com.softload.panel.repository']))||
     !/^sha256:[a-f0-9]{64}$/.test(String(input.Image)))return false;
 }
 return keys(host,['NetworkMode','ReadonlyRootfs','Memory','MemorySwap','NanoCpus','PidsLimit','CapDrop','SecurityOpt','Init','AutoRemove','PublishAllPorts','Tmpfs'])&&
  ['bridge','softload_panel_apps'].includes(String(host.NetworkMode))&&host.ReadonlyRootfs===true&&ram.has(host.Memory as number)&&
  host.MemorySwap===(host.Memory as number)*2&&cpus.has(host.NanoCpus as number)&&host.PidsLimit===64&&
  JSON.stringify(host.CapDrop)==='["ALL"]'&&JSON.stringify(host.SecurityOpt)==='["no-new-privileges"]'&&
  host.Init===false&&host.AutoRemove===false&&host.PublishAllPorts===false&&
  object(host.Tmpfs)&&keys(host.Tmpfs,['/tmp'])&&host.Tmpfs['/tmp']==='rw,nosuid,nodev,size=16m,mode=1777';
}
export function validLimits(input:unknown):boolean{
 return object(input)&&keys(input,['Memory','MemorySwap','NanoCpus'])&&ram.has(input.Memory as number)&&
  cpus.has(input.NanoCpus as number)&&input.MemorySwap===(input.Memory as number)*2;
}
async function authorizedContainer(id:string,inspect:(id:string)=>Promise<Inspect|null>,operation:string):Promise<Decision>{
 const item=await inspect(id);
 if(!item?.Id||!item.Name?.startsWith('/'))return denied('Container does not exist');
 const name=item.Name.slice(1);
 if(id!==name&&id!==item.Id)return denied('Inspect target mismatch');
 if(services.has(name))return ['read','start','stop','restart'].includes(operation)?{...approved(name),targetId:item.Id}:denied('Protected service');
 if(monitor.has(name))return operation==='read'?{...approved(name),targetId:item.Id}:denied('Read-only system service');
 const slot=slots.exec(name);
 if(!slot||slot[2].length>40||item.Config?.Labels?.[owner]!=='true'||item.Config.Labels[slugLabel]!==slot[2])return denied('Unmanaged container');
 if(slot[1]==='candidate'&&item.Config.Labels['com.softload.panel.release-role']!=='candidate')return denied('Untrusted release slot');
 if(operation==='delete'&&(item.State?.Running||item.State?.Status==='running'))return denied('Must stop container before removal');
 return {...approved(name),targetId:item.Id};
}
export async function authorize(input:{method:string;url:string;payload?:unknown;inspect:(id:string)=>Promise<Inspect|null>;images?:string[];ghcrOwner?:string}):Promise<Decision>{
 const {method,payload,inspect}=input;
 let u:URL;
 try{u=new URL(input.url,'http://docker.internal')}catch{return denied('Malformed URI')}
 if(!u.pathname.startsWith('/v1.45/'))return denied('Unsupported Docker version');
 const path=u.pathname.slice('/v1.45'.length),q=u.searchParams;
 if(method==='GET'){
  if(path==='/containers/json'&&q.get('all')==='1'&&[...q.keys()].every(k=>['all','filters','size'].includes(k))&&
    (!q.has('size')||q.get('size')==='1')){
   if(q.has('filters')){
     try{if(JSON.stringify(JSON.parse(q.get('filters')||''))!==JSON.stringify({label:[owner+'=true']}))return denied('Unsafe filters');}
     catch{return denied('Invalid filters')}
   }
   return {...approved(),filterList:true};
  }
  if(path==='/images/json'&&!u.search)return approved();
  if(path==='/system/df'&&q.get('type')==='images'&&[...q.keys()].length===1)return approved();
  if(path.startsWith('/images/')&&path.endsWith('/json')&&!u.search){
   const ref=decodeURIComponent(path.slice(8,-5));
   return /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+(@sha256:[a-f0-9]{64}|:sha-[a-f0-9]{40})$/.test(ref)?approved():denied('Image inspect not approved');
  }
 }
 if(path==='/containers/create'&&method==='POST'){
   return [...q.keys()].join(',')==='name'&&validCreate(q.get('name')||'',payload,input.images||[])?approved(q.get('name')||''):denied('Unsafe create payload');
 }
 if(path==='/images/create'&&method==='POST'){
   const ownerName=input.ghcrOwner||'Softdown-prog';
   if(!/^[A-Za-z0-9-]{1,39}$/.test(ownerName))return denied('Invalid owner policy');
   const ref=q.get('fromImage')||'';
   const prefix='ghcr.io/'+ownerName.toLowerCase()+'/';
   return [...q.keys()].join(',')==='fromImage'&&ref.startsWith(prefix)&&
     /^[a-z0-9_.-]+@sha256:[a-f0-9]{64}$/.test(ref.slice(prefix.length))?approved():denied('Unapproved image pull');
 }
 const route=/^\/containers\/([^/]+)(?:\/(json|logs|stats|start|stop|restart|rename|update))?$/.exec(path);
 if(!route)return denied('Operation not allowlisted');
 let id:string;
 try{id=decodeURIComponent(route[1])}catch{return denied('Invalid target')}
 if(!/^[a-zA-Z0-9_-]{2,80}$/.test(id))return denied('Invalid target');
 const action=route[2]||'delete';
 if(action==='delete'){
  if(method!=='DELETE'||q.get('force')!=='0'||q.get('v')!=='0'||[...q.keys()].length!==2)return denied('Unsafe delete');
 }else if(action==='json'&&method==='GET'&&!u.search){}
 else if(action==='logs'&&method==='GET'&&[...q.keys()].every(k=>['stdout','stderr','tail','timestamps'].includes(k))&&/^[1-9][0-9]{0,2}$/.test(q.get('tail')||'')){}
 else if(action==='stats'&&method==='GET'&&q.get('stream')==='false'&&q.get('one-shot')==='true'&&[...q.keys()].length===2){}
 else if(action==='update'&&method==='POST'&&!u.search&&validLimits(payload)){}
 else if(action==='rename'&&method==='POST'&&[...q.keys()].join(',')==='name'&&slots.test(q.get('name')||'')){}
 else if(['start','stop','restart'].includes(action)&&method==='POST'&&[...q.keys()].every(k=>k==='t')&&
   (!q.has('t')||['10','15'].includes(q.get('t')||''))){}
 else return denied('Invalid operation parameters');
 const target=await authorizedContainer(id,inspect,['json','logs','stats'].includes(action)?'read':action);
 if(!target.ok)return target;
 if(action==='rename'){
  const from=slots.exec(target.name||''),to=slots.exec(q.get('name')||'');
  if(!from||!to||from[2]!==to[2]||!['app:backup','candidate:app','backup:app','app:candidate'].includes(from[1]+':'+to[1]))
   return denied('Cross-application or invalid rename');
 }
 return target;
}
export function visibleContainers<T extends {Names?:string[];Labels?:Record<string,string>}>(list:T[]):T[]{
 return list.filter(c=>(c.Names||[]).some(n=>{
  const name=n.replace(/^\//,'');const slot=slots.exec(name);
  return services.has(name)||monitor.has(name)||
    (Boolean(slot)&&slot![2].length<=40&&c.Labels?.[owner]==='true'&&c.Labels[slugLabel]===slot![2]);
 }));
}
