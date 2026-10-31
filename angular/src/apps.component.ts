import { Component, OnInit, computed, signal } from '@angular/core';
import {
  canCreateApp, canOperate, diskMb, validAppDraft, validSnapshot,
  type AppAction, type AppDraft, type AppsSnapshot, type ManagedApp
} from './apps-policy';

@Component({
  selector:'panel-managed-apps',
  standalone:true,
  templateUrl:'./apps.component.html',
  styleUrl:'./apps.component.css'
})
export class AppsComponent implements OnInit {
  readonly data=signal<AppsSnapshot|null>(null);
  readonly loading=signal(false);
  readonly acting=signal<string|null>(null);
  readonly error=signal('');
  readonly notice=signal('');
  readonly slug=signal('');
  readonly image=signal('');
  readonly ramMb=signal(256);
  readonly cpuCores=signal(0.5);
  readonly drafts=signal<Record<string,AppDraft>>({});
  readonly selectedLogs=signal<string|null>(null);
  readonly logs=signal('');
  readonly logsBusy=signal(false);
  readonly diskMb=diskMb;
  readonly canCreate=computed(()=>canCreateApp(this.data(),this.slug(),this.image(),this.ramMb(),this.cpuCores()));
  readonly running=computed(()=>(this.data()?.applications??[]).filter(app=>app.state==='running').length);

  ngOnInit():void { void this.refresh(); }

  private async request<T>(path:string,method:'GET'|'POST'|'DELETE'='GET',payload?:object):Promise<T> {
    const response=await fetch('/api'+path,{
      method,credentials:'same-origin',cache:'no-store',redirect:'error',
      headers:payload?{'content-type':'application/json',accept:'application/json'}:{accept:'application/json'},
      ...(payload?{body:JSON.stringify(payload)}:{})
    });
    const result:unknown=await response.json();
    if (!result || typeof result!=='object' || Array.isArray(result))
      throw new Error('Resposta inválida da API da VPS.');
    if(!response.ok){
      const detail=(result as {error?:unknown}).error;
      throw new Error(response.status===401?'Sessão expirada. Entre novamente.':
        typeof detail==='string'?detail:'Operação recusada (HTTP '+response.status+').');
    }
    return result as T;
  }
  private detail(error:unknown):string {
    return error instanceof Error?error.message:'Não foi possível comunicar com a VPS.';
  }
  async refresh():Promise<void> {
    if(this.loading())return;
    this.loading.set(true);this.error.set('');
    try {
      const result=await this.request<AppsSnapshot>('/apps');
      if (!validSnapshot(result)) throw new Error('O servidor não confirmou o inventário de aplicações.');
      this.data.set(result);
      const previous=this.drafts();
      this.drafts.set(Object.fromEntries(result.applications.map(app=>[
        app.slug,previous[app.slug]??{ramMb:app.ramMb,cpuCores:app.cpuCores,idleMinutes:app.idleMinutes}
      ])));
      if(!result.allowedImages.includes(this.image()))this.image.set(result.allowedImages[0]??'');
      if(!result.ramChoices.includes(this.ramMb()))this.ramMb.set(result.ramChoices[0]??256);
      if(!result.cpuChoices.includes(this.cpuCores()))this.cpuCores.set(result.cpuChoices[0]??0.5);
      if(this.selectedLogs() && !result.applications.some(app=>app.slug===this.selectedLogs())){
        this.selectedLogs.set(null);this.logs.set('');
      }
    }catch(error){this.error.set(this.detail(error));}
    finally{this.loading.set(false);}
  }
  updateCreate(field:'slug'|'image'|'ramMb'|'cpuCores',event:Event):void {
    const value=(event.target as HTMLInputElement|HTMLSelectElement).value;
    if(field==='slug')this.slug.set(value.trim().toLowerCase());
    if(field==='image')this.image.set(value);
    if(field==='ramMb')this.ramMb.set(Number(value));
    if(field==='cpuCores')this.cpuCores.set(Number(value));
  }
  draft(app:ManagedApp):AppDraft {
    return this.drafts()[app.slug]??{ramMb:app.ramMb,cpuCores:app.cpuCores,idleMinutes:app.idleMinutes};
  }
  updateDraft(slug:string,field:keyof AppDraft,event:Event):void {
    const value=Number((event.target as HTMLSelectElement).value);
    const item=this.drafts()[slug];
    if(item)this.drafts.update(drafts=>({...drafts,[slug]:{...item,[field]:value}}));
  }
  allowed(app:ManagedApp,action:AppAction):boolean {
    return !this.acting() && canOperate(this.data(),app,action);
  }

  async create(event:Event):Promise<void> {
    event.preventDefault();
    if(this.acting() || !this.canCreate())return;
    const slug=this.slug();
    this.acting.set('creating');this.error.set('');this.notice.set('');
    try {
      await this.request('/apps','POST',{
        slug,image:this.image(),ramMb:this.ramMb(),cpuCores:this.cpuCores()
      });
      this.slug.set('');
      await this.refresh();
      this.notice.set('Aplicação '+slug+' criada desligada. Inicie somente quando estiver pronta.');
    }catch(error){this.error.set(this.detail(error));}
    finally{this.acting.set(null);}
  }

  async operate(app:ManagedApp,action:AppAction):Promise<void> {
    if(this.acting() || !canOperate(this.data(),app,action))return;
    const title={start:'iniciar',stop:'parar',restart:'reiniciar',remove:'remover'}[action];
    const prompt=action==='remove'?
      'Remover definitivamente o container '+app.slug+'? Confira os domínios vinculados. Esta ação não pode ser desfeita.':
      'Deseja '+title+' a aplicação '+app.slug+'? Essa operação afeta o serviço na VPS.';
    if(!window.confirm(prompt))return;
    this.acting.set(app.slug);this.error.set('');this.notice.set('');
    try {
      await this.request('/apps/'+app.slug+(action==='remove'?'':'/'+action),
        action==='remove'?'DELETE':'POST');
      await this.refresh();
      this.notice.set('Operação '+title+' concluída para '+app.slug+'.');
    }catch(error){this.error.set(this.detail(error));}
    finally{this.acting.set(null);}
  }

  async saveResources(app:ManagedApp):Promise<void> {
    const data=this.data(),draft=this.draft(app);
    if(this.acting()||!data?.applications.some(item=>item.slug===app.slug)||
      !validAppDraft(data,draft))return;
    if(!window.confirm('Atualizar limites de RAM/CPU da aplicação '+app.slug+' na VPS?'))return;
    this.acting.set(app.slug);this.error.set('');this.notice.set('');
    try{
      await this.request('/apps/'+app.slug+'/resources','POST',{
        ramMb:draft.ramMb,cpuCores:draft.cpuCores
      });
      this.drafts.update(old=>({...old,[app.slug]:{...draft}}));
      await this.refresh();
      this.notice.set('Limites de '+app.slug+' atualizados.');
    }catch(error){this.error.set(this.detail(error));}
    finally{this.acting.set(null);}
  }

  async saveIdle(app:ManagedApp):Promise<void> {
    const data=this.data(),draft=this.draft(app);
    if(this.acting()||!data?.applications.some(item=>item.slug===app.slug)||
      !validAppDraft(data,draft))return;
    if(draft.idleMinutes>0 && !window.confirm('Desligar automaticamente '+app.slug+
      ' após '+draft.idleMinutes+' minutos sem atividade? O reinício é manual.'))return;
    this.acting.set(app.slug);this.error.set('');this.notice.set('');
    try{
      await this.request('/apps/'+app.slug+'/idle','POST',{minutes:draft.idleMinutes});
      await this.refresh();
      this.notice.set('Política de ociosidade de '+app.slug+' atualizada.');
    }catch(error){this.error.set(this.detail(error));}
    finally{this.acting.set(null);}
  }

  async showLogs(app:ManagedApp):Promise<void> {
    if(this.logsBusy())return;
    if(!this.data()?.applications.some(item=>item.slug===app.slug))return;
    this.selectedLogs.set(app.slug);this.logs.set('Consultando registros…');
    this.logsBusy.set(true);this.error.set('');
    try{
      const result=await this.request<{lines?:unknown}>('/apps/'+app.slug+'/logs');
      if(this.selectedLogs()===app.slug)
        this.logs.set(typeof result.lines==='string'&&result.lines?result.lines:'Nenhum registro encontrado.');
    }catch(error){if(this.selectedLogs()===app.slug)this.logs.set(this.detail(error));}
    finally{this.logsBusy.set(false);}
  }
  closeLogs():void{this.selectedLogs.set(null);this.logs.set('');}
}
