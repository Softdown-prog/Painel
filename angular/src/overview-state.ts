/** Strictly checked host data: do not show unverified API values as live metrics. */
export type HostOverview={
  containerSummary:{available:boolean;running:number|null;total:number|null;truncated:boolean};
  cpu?:{load1:number;cores:number};
  disk?:{used:number;total:number};
  updatedAt:string;
};
export type HostInventory={
  readOnly:true;updatedAt:string;truncated:boolean;
  containers:Array<{name:string;image:string;state:string;status:string;project:string|null}>;
};
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const number=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const integer=(v:unknown):v is number=>number(v)&&Number.isSafeInteger(v);
const date=(v:unknown):v is string=>typeof v==='string'&&v.length<=64&&Number.isFinite(Date.parse(v));
const str=(v:unknown,max:number):string=>typeof v==='string'?v.slice(0,max):'';

export function parseOverview(raw:unknown):HostOverview{
  if(!record(raw)||!date(raw.updatedAt)||!record(raw.containerSummary)||
     typeof raw.containerSummary.available!=='boolean')
    throw Error('A API não confirmou as métricas da VPS.');
  const summary=raw.containerSummary;
  const available=summary.available===true;
  if(available&&(!integer(summary.running)||!integer(summary.total)||summary.running>summary.total))
    throw Error('A contagem de containers recebida é inválida.');
  const result:HostOverview={
    updatedAt:raw.updatedAt,
    containerSummary:{
      available,
      running:available?summary.running as number:null,
      total:available?summary.total as number:null,
      truncated:summary.truncated===true
    }
  };
  if(record(raw.cpu)&&number(raw.cpu.load1)&&integer(raw.cpu.cores)&&raw.cpu.cores>0)
    result.cpu={load1:raw.cpu.load1,cores:raw.cpu.cores};
  if(record(raw.disk)&&number(raw.disk.used)&&number(raw.disk.total)&&raw.disk.total>0&&raw.disk.used<=raw.disk.total)
    result.disk={used:raw.disk.used,total:raw.disk.total};
  return result;
}
export function parseInventory(raw:unknown):HostInventory{
  if(!record(raw)||raw.readOnly!==true||!date(raw.updatedAt)||!Array.isArray(raw.containers))
    throw Error('O inventário de containers não foi confirmado pela API.');
  const containers:HostInventory['containers']=[];
  for(const item of raw.containers){
    if(!record(item)||typeof item.name!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(item.name))
      throw Error('O inventário contém uma entrada inválida.');
    containers.push({
      name:item.name,image:str(item.image,180)||'Imagem não informada',
      state:str(item.state,30),status:str(item.status,120),
      project:typeof item.project==='string'?str(item.project,80):null
    });
  }
  return {readOnly:true,updatedAt:raw.updatedAt,truncated:raw.truncated===true,containers};
}
