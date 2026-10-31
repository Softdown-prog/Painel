/**
 * Frontend constraints mirror GET /apps and its explicit Docker ownership boundary.
 * The backend remains the final authority for every mutation.
 */
export type ManagedApp = {
  slug:string; name:string; image:string; state:string; status:string;
  ramMb:number; cpuCores:number; diskUsedBytes:number|null; idleMinutes:number;
};
export type AppsSnapshot = {
  enabled:boolean; allowedImages:string[]; maxApps:number;
  ramChoices:number[]; cpuChoices:number[]; idleChoices:number[];
  applications:ManagedApp[];
};
export type AppAction = 'start'|'stop'|'restart'|'remove';
export type AppDraft = {ramMb:number; cpuCores:number; idleMinutes:number};
const SLUG=/^(?=.{2,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function validAppSlug(value:string):boolean { return SLUG.test(value); }
export function validSnapshot(value:unknown):value is AppsSnapshot {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const data=value as Partial<AppsSnapshot>;
  return typeof data.enabled==='boolean' &&
    Array.isArray(data.applications) && data.applications.every((app:unknown)=>{
      if (!app || typeof app!=='object') return false;
      const item=app as Partial<ManagedApp>;
      return typeof item.slug==='string' && validAppSlug(item.slug) &&
        typeof item.name==='string' && typeof item.image==='string' &&
        typeof item.state==='string' && typeof item.ramMb==='number' &&
        typeof item.cpuCores==='number' && typeof item.idleMinutes==='number';
    }) &&
    Array.isArray(data.allowedImages) && data.allowedImages.every(v=>typeof v==='string') &&
    Number.isInteger(data.maxApps) && (data.maxApps as number)>0 &&
    Array.isArray(data.ramChoices) && data.ramChoices.every(v=>typeof v==='number') &&
    Array.isArray(data.cpuChoices) && data.cpuChoices.every(v=>typeof v==='number') &&
    Array.isArray(data.idleChoices) && data.idleChoices.every(v=>typeof v==='number');
}
export function canCreateApp(data:AppsSnapshot|null, slug:string, image:string,
  ramMb:number, cpuCores:number):boolean {
  return Boolean(data?.enabled && validAppSlug(slug) && data.allowedImages.includes(image) &&
    data.ramChoices.includes(ramMb) && data.cpuChoices.includes(cpuCores) &&
    data.applications.length<data.maxApps &&
    !data.applications.some(a=>a.slug===slug));
}
export function canOperate(data:AppsSnapshot|null, app:ManagedApp,action:AppAction):boolean {
  if (!data?.enabled || !validAppSlug(app.slug) ||
      !data.applications.some(a=>a.slug===app.slug && a.name===app.name && a.state===app.state))
    return false;
  if (action==='start') return ['created','exited'].includes(app.state);
  if (action==='stop' || action==='restart') return app.state==='running';
  return app.state!=='running';
}
export function validAppDraft(data:AppsSnapshot|null,draft:AppDraft):boolean {
  return Boolean(data?.enabled && data.ramChoices.includes(draft.ramMb) &&
    data.cpuChoices.includes(draft.cpuCores) &&
    data.idleChoices.includes(draft.idleMinutes));
}
export function diskMb(value:number|null):string {
  return typeof value==='number' && Number.isFinite(value) && value>=0 ?
    (value/1048576).toFixed(1).replace('.',',')+' MB' : 'Não informado';
}
