export type InfraKind='mcp'|'cluster';
export type InfraTopology='single-node'|'regional';
export type InfraPlan={
 id:string;projectSlug:string;name:string;kind:InfraKind;
 replicas:number;topology:InfraTopology;transport:'streamable-http'|null;
 exposure:'private';runtime:'not-provisioned';createdAt:string;updatedAt:string;
 projectLinked:boolean;
};
export type InfraSnapshot={
 projects:string[];plans:InfraPlan[];
 capabilities:{configuration:true;provisioning:false;healthMonitoring:false;lifecycle:false};
 limits:{total:number;perProject:number;maxClusterReplicas:number};
};
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export const validInfraSlug=(s:string):boolean=>s.length>0&&s.length<=48&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v);
export function parseInfraSnapshot(value:unknown):InfraSnapshot{
 if(!record(value)||!Array.isArray(value['projects'])||!Array.isArray(value['plans'])||
   !record(value['capabilities'])||!record(value['limits']))
   throw Error('A API não confirmou o cadastro de infraestrutura.');
 const caps=value['capabilities'];
 const limits=value['limits'];
 if(caps['configuration']!==true||caps['provisioning']!==false||
    caps['healthMonitoring']!==false||caps['lifecycle']!==false||
    !integer(limits['total'])||limits['total']>128||limits['total']<1||
    !integer(limits['perProject'])||limits['perProject']>32||limits['perProject']<1||
    !integer(limits['maxClusterReplicas'])||limits['maxClusterReplicas']>32||
    limits['maxClusterReplicas']<1)
   throw Error('Capacidades de infraestrutura inválidas.');
 if(!value['projects'].every((p:unknown)=>typeof p==='string'&&validInfraSlug(p))||
    !value['plans'].every((plan:unknown)=>{
      if(!record(plan)||typeof plan['projectSlug']!=='string'||!validInfraSlug(plan['projectSlug'])||
        typeof plan['name']!=='string'||!validInfraSlug(plan['name'])||
        (plan['kind']!=='mcp'&&plan['kind']!=='cluster')||
        plan['id']!==plan['projectSlug']+'.'+plan['kind']+'.'+plan['name']||
        !integer(plan['replicas'])||plan['replicas']<1||
        plan['replicas']>limits['maxClusterReplicas']||
        (plan['topology']!=='single-node'&&plan['topology']!=='regional')||
        plan['runtime']!=='not-provisioned'||plan['exposure']!=='private'||
        typeof plan['projectLinked']!=='boolean'||
        typeof plan['createdAt']!=='string'||!Number.isFinite(Date.parse(plan['createdAt']))||
        typeof plan['updatedAt']!=='string'||!Number.isFinite(Date.parse(plan['updatedAt'])))return false;
      return plan['kind']==='mcp'?
        plan['replicas']===1&&plan['topology']==='single-node'&&plan['transport']==='streamable-http':
        plan['transport']===null;
    })||value['plans'].length>limits['total'])
   throw Error('Configuração de infraestrutura inesperada.');
 return {
   projects:value['projects'] as string[],
   plans:value['plans'] as InfraPlan[],
   capabilities:{configuration:true,provisioning:false,healthMonitoring:false,lifecycle:false},
   limits:{total:limits['total'],perProject:limits['perProject'],
     maxClusterReplicas:limits['maxClusterReplicas']}
 };
}
export function validInfraDraft(
 data:InfraSnapshot|null,kind:InfraKind,project:string,name:string,
 replicas:number,topology:InfraTopology,editingId:string|null
):boolean{
 if(!data||!data.capabilities.configuration||!data.projects.includes(project)||
    !validInfraSlug(name)||!Number.isSafeInteger(replicas)||replicas<1||
    replicas>(kind==='mcp'?1:data.limits.maxClusterReplicas)||
    (kind==='mcp'&&topology!=='single-node'))return false;
 const id=project+'.'+kind+'.'+name;
 if(editingId!==null){
   const existing=data.plans.find(p=>p.id===editingId);
   return !!existing&&existing.id===id&&existing.projectLinked;
 }
 return !data.plans.some(p=>p.id===id)&&data.plans.length<data.limits.total&&
   data.plans.filter(p=>p.projectSlug===project).length<data.limits.perProject;
}
