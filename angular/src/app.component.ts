import { Component, ElementRef, HostListener, OnInit, OnDestroy, ViewChild, computed, signal } from '@angular/core';
import { DeploymentsComponent } from './deployments.component';
import { AppsComponent } from './apps.component';
import { GithubProjectsComponent } from './github-projects.component';
import { TerminalComponent } from './terminal.component';
import { RevisionsComponent } from './revisions.component';
import { PostgresComponent } from './postgres.component';
import { DomainsComponent } from './domains.component';
import { TrafficComponent } from './traffic.component';
import { SecretsComponent } from './secrets.component';
import { SettingsComponent } from './settings.component';
import { LegacyServicesComponent } from './legacy-services.component';
import { SiteDetailComponent } from './site-detail.component';
import { InfrastructureComponent } from './infrastructure.component';
import { validAppSlug } from './apps-policy';
import {parseOverview,parseInventory,capacityAlerts,readingFresh,type HostOverview,type HostInventory} from './overview-state';
import {filterInventory,inventoryProjects,type InventoryStatusFilter} from './inventory-view';
import {parseAdminSession,expiredProtectedSession,maySubmitAdminLogin,type AdminSession} from './session-state';

@Component({
  selector: 'panel-app',
  standalone: true,
  imports: [DeploymentsComponent, AppsComponent, GithubProjectsComponent, TerminalComponent, RevisionsComponent, PostgresComponent, DomainsComponent, TrafficComponent, SecretsComponent, SettingsComponent, LegacyServicesComponent, SiteDetailComponent, InfrastructureComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit,OnDestroy {
  readonly page = signal<'overview' | 'containers' | 'deployments' | 'apps' | 'projects' | 'terminal' | 'revisions' | 'database' | 'domains' | 'traffic' | 'secrets' | 'settings' | 'site' | 'infrastructure'>('overview');
  readonly selectedSiteSlug=signal<string|null>(null);
  readonly menuOpen = signal(false);
  @ViewChild('sidebarPanel') sidebarPanel?:ElementRef<HTMLElement>;
  @ViewChild('menuTrigger') menuTrigger?:ElementRef<HTMLButtonElement>;
  @ViewChild('pageTitle') pageTitle?:ElementRef<HTMLHeadingElement>;
  readonly session = signal<AdminSession | null>(null);
  readonly overview = signal<HostOverview | null>(null);
  readonly inventory = signal<HostInventory | null>(null);
  readonly overviewIssue=signal('');
  readonly inventoryIssue=signal('');
  readonly inventorySearch=signal('');
  readonly inventoryStatus=signal<InventoryStatusFilter>('all');
  readonly inventoryProject=signal('');
  readonly projectOptions=computed(()=>inventoryProjects(this.inventory()));
  readonly visibleContainers=computed(()=>filterInventory(this.inventory(),{
    query:this.inventorySearch(),status:this.inventoryStatus(),project:this.inventoryProject()
  }));
  private authEpoch=0;
  private sessionCheckId=0;
  readonly sessionChecking=signal(false);
  readonly logoutUnconfirmed=signal(false);
  readonly logoutPending=signal(false);
  readonly loginAllowed=computed(()=>maySubmitAdminLogin(
    this.session(),this.logoutPending(),this.logoutUnconfirmed(),
    this.submitting(),this.sessionChecking()
  ));
  private timer:ReturnType<typeof setInterval>|null=null;
  private destroyed=false;
  readonly clock=signal(Date.now());
  readonly overviewFresh=computed(()=>readingFresh(this.overview()?.updatedAt,this.clock())&&!this.overviewIssue());
  readonly alerts=computed(()=>this.overviewFresh()?capacityAlerts(this.overview()):[]);
  readonly loading = signal(false);
  readonly submitting = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly username = signal('admin');
  readonly password = signal('');
  readonly setupToken=signal('');
  readonly setupPassword=signal('');
  readonly setupRepeat=signal('');
  readonly setupPending=signal(false);
  readonly setupValid=computed(()=>this.setupToken().trim().length>0&&this.setupPassword().length>=14&&
    this.setupPassword().length<=256&&this.setupPassword()===this.setupRepeat());
  readonly activeContainers = computed(() =>
    (this.inventory()?.containers ?? []).filter(c => c.state === 'running').length);
  readonly signedIn = computed(() => this.session()?.authenticated === true);

  async ngOnInit(): Promise<void> {
    this.syncPageFromLocation();
    // Verify the administrative session on all pages, not only the metrics dashboard.
    this.timer=setInterval(()=>{
      this.clock.set(Date.now());
      if(document.visibilityState==='visible'&&this.signedIn())void this.revalidateVisiblePage();
    },60_000);
    if(await this.checkSession()&&(this.page()==='overview'||this.page()==='containers'))
      await this.refresh();
  }

  private async revalidateVisiblePage():Promise<void> {
    if(this.destroyed||!this.signedIn()||this.logoutUnconfirmed())return;
    if(await this.checkSession()&&(this.page()==='overview'||this.page()==='containers'))
      await this.refresh(true);
  }

  ngOnDestroy():void {
    this.destroyed=true;
    this.authEpoch++;
    this.sessionCheckId++;
    if(this.timer!==null)clearInterval(this.timer);
    this.timer=null;
    this.clearReadings();
  }

  @HostListener('document:visibilitychange')
  onVisibilityChange():void {
    this.clock.set(Date.now());
    if(document.visibilityState==='visible'&&this.signedIn())void this.revalidateVisiblePage();
  }

  @HostListener('window:hashchange')
  onRouteChange(): void {
    const previous=this.page();
    this.syncPageFromLocation();
    this.menuOpen.set(false);
    if(previous!==this.page())this.focusPageTitle();
    if(previous!==this.page()&&this.signedIn()&&document.visibilityState==='visible')
      void this.revalidateVisiblePage();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if(this.menuOpen())this.closeMenu(true);
  }

  @HostListener('window:resize')
  onResize():void {
    // At desktop widths the drawer becomes a regular sidebar. Never leave main inert.
    if(this.menuOpen()&&window.innerWidth>900){
      this.closeMenu();
      this.focusPageTitle();
    }
  }

  /** A modal navigation drawer must keep keyboard focus inside while open. */
  onSidebarKeydown(event:KeyboardEvent):void{
    if(!this.menuOpen()||event.key!=='Tab')return;
    const sidebar=this.sidebarPanel?.nativeElement;
    if(!sidebar)return;
    const items=Array.from(sidebar.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )).filter(item=>item.getClientRects().length>0);
    const first=items[0],last=items[items.length-1];
    if(!first||!last)return;
    if(event.shiftKey&&(document.activeElement===first||!sidebar.contains(document.activeElement))){
      event.preventDefault();last.focus();
    }else if(!event.shiftKey&&(document.activeElement===last||!sidebar.contains(document.activeElement))){
      event.preventDefault();first.focus();
    }
  }
  private focusPageTitle():void{
    queueMicrotask(()=>{
      if(!this.destroyed&&!this.menuOpen())this.pageTitle?.nativeElement.focus({preventScroll:true});
    });
  }
  skipToContent(event:MouseEvent):void {
    event.preventDefault();
    this.focusPageTitle();
  }

  private syncPageFromLocation(): void {
    const hash = window.location.hash.replace(/^#\/?/, '');
    const [view,query]=hash.split('?');
    if(view==='site'){
      const slug=new URLSearchParams(query??'').get('slug')??'';
      this.selectedSiteSlug.set(validAppSlug(slug)?slug:null);
      this.page.set('site');
      return;
    }
    this.selectedSiteSlug.set(null);
    if (hash === 'overview' || hash === 'containers' ||
        hash === 'deployments' || hash === 'apps' || hash === 'projects' ||
        hash === 'terminal' || hash === 'revisions' ||
        hash === 'database' || hash === 'domains' || hash === 'traffic' ||
        hash === 'secrets' || hash === 'settings' || hash === 'infrastructure') this.page.set(hash);
    else this.page.set('overview');
  }

  setInventorySearch(event:Event):void {
    const element=event.target;
    if(element instanceof HTMLInputElement)this.inventorySearch.set(element.value.slice(0,100));
  }
  setInventoryStatus(event:Event):void {
    const element=event.target;
    if(!(element instanceof HTMLSelectElement))return;
    if(element.value==='all'||element.value==='running'||element.value==='other')
      this.inventoryStatus.set(element.value);
  }
  setInventoryProject(event:Event):void {
    const element=event.target;
    if(!(element instanceof HTMLSelectElement))return;
    if(element.value===''||this.projectOptions().includes(element.value))
      this.inventoryProject.set(element.value);
  }
  resetInventoryFilters():void {
    this.inventorySearch.set('');
    this.inventoryStatus.set('all');
    this.inventoryProject.set('');
  }

  toggleMenu(): void {
    if(this.menuOpen()){this.closeMenu(true);return;}
    this.menuOpen.set(true);
    queueMicrotask(()=>{
      if(this.menuOpen()&&!this.destroyed)
        this.sidebarPanel?.nativeElement.querySelector<HTMLButtonElement>('.menu-close')?.focus();
    });
  }
  closeMenu(restoreFocus=false): void {
    const wasOpen=this.menuOpen();
    this.menuOpen.set(false);
    if(wasOpen&&restoreFocus)queueMicrotask(()=>{
      if(!this.destroyed&&!this.menuOpen())this.menuTrigger?.nativeElement.focus({preventScroll:true});
    });
  }


  async request<T>(path: string, method = 'GET', payload?: object): Promise<T> {
    // The VPS web gateway keeps x-panel-edge-key only on the server. Never store it here.
    const response = await fetch('/api' + path, {
      method, ...(payload ? {headers: {'content-type':'application/json'},body:JSON.stringify(payload)} : {}),
      credentials: 'same-origin', redirect: 'error', cache: 'no-store'
    });
    if(expiredProtectedSession(response.status,path)){
      if(this.signedIn())this.lockSession('Sessão administrativa expirada. Faça login novamente.');
      throw Error('Sessão administrativa expirada. Faça login novamente.');
    }
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('A API da VPS devolveu uma resposta inesperada.');
    if (!response.ok) {
      const obj = data as {error?: unknown};
      throw new Error(typeof obj.error === 'string' ? obj.error : 'A API não respondeu (HTTP ' + response.status + ').');
    }
    return data as T;
  }

  private lockSession(message:string):void {
    this.authEpoch++;
    this.sessionCheckId++;
    this.session.set({authenticated:false,setupRequired:false});
    this.clearReadings();
    this.password.set('');
    this.cancelSetup();
    this.menuOpen.set(false);
    this.error.set(message);
  }

  async checkSession():Promise<boolean> {
    if(this.destroyed||this.logoutUnconfirmed()||this.logoutPending())return false;
    const checkId=++this.sessionCheckId;
    const epoch=this.authEpoch;
    this.sessionChecking.set(true);
    try {
      const session=parseAdminSession(await this.request<unknown>('/session'));
      if(epoch!==this.authEpoch||checkId!==this.sessionCheckId||this.destroyed)return false;
      if(!session.authenticated){
        if(this.signedIn())this.lockSession('Sessão administrativa encerrada. Faça login novamente.');
        else this.clearReadings();
        this.session.set(session);
        return false;
      }
      this.session.set(session);
      this.error.set('');
      return true;
    }catch(error){
      if(epoch===this.authEpoch&&checkId===this.sessionCheckId&&!this.destroyed){
        const reason=this.signedIn()
          ? 'Não foi possível revalidar a sessão. A área administrativa foi bloqueada até nova confirmação.'
          : this.message(error);
        this.lockSession(reason);
        this.session.set(null);
      }
      return false;
    }finally{
      if(checkId===this.sessionCheckId||this.destroyed||!this.signedIn())
        this.sessionChecking.set(false);
    }
  }

  private clearReadings():void{
    this.resetInventoryFilters();
    this.overview.set(null);this.inventory.set(null);
    this.overviewIssue.set('');this.inventoryIssue.set('');
    this.loading.set(false);this.notice.set('');
  }

  prepareSetup(event:Event):void{
    event.preventDefault();
    if(this.submitting()||this.logoutPending()||this.logoutUnconfirmed()||
       !this.session()?.setupRequired||!this.setupValid())return;
    this.error.set('');this.setupPending.set(true);
  }

  cancelSetup():void{
    this.setupToken.set('');this.setupPassword.set('');this.setupRepeat.set('');
    this.setupPending.set(false);
  }

  async completeSetup():Promise<void>{
    if(!this.setupPending()||!this.session()?.setupRequired||!this.setupValid()||
       this.submitting()||this.logoutPending()||this.logoutUnconfirmed())return;
    this.submitting.set(true);this.error.set('');
    try{
      const data=await this.request<{ok:boolean}>('/setup','POST',{
        setupToken:this.setupToken().trim(),password:this.setupPassword()
      });
      if(data.ok!==true)throw Error('A inicialização administrativa não foi confirmada.');
      this.cancelSetup();
      await this.checkSession();
      this.notice.set('Administrador criado. Entre com a nova senha para continuar.');
    }catch(e){
      this.error.set(this.message(e));
      this.cancelSetup();
    }finally{this.submitting.set(false);}
  }
  
  onPasswordChanged():void {
    this.authEpoch++;
    this.sessionCheckId++;
    this.logoutUnconfirmed.set(false);
    this.logoutPending.set(false);
    this.session.set({authenticated:false,setupRequired:false});
    this.clearReadings();
    this.password.set('');
    this.cancelSetup();
    this.menuOpen.set(false);
    this.error.set('');
    this.notice.set('Senha alterada. Entre novamente.');
    this.selectPage('overview');
  }

  async login(event: Event): Promise<void> {
    event.preventDefault();
    if(!this.loginAllowed())return;
    const epoch=this.authEpoch;
    this.submitting.set(true);
    this.error.set('');
    try {
      const result=await this.request<{ok:boolean}>('/login','POST',{
        username:this.username().trim(),password:this.password()
      });
      if(epoch!==this.authEpoch||this.destroyed)return;
      if(result.ok!==true)throw Error('O servidor não confirmou a entrada.');
      this.logoutUnconfirmed.set(false);
      if(await this.checkSession()&&(this.page()==='overview'||this.page()==='containers'))
        await this.refresh();
    }catch(err){
      if(epoch===this.authEpoch&&!this.destroyed)this.error.set(this.message(err));
    }finally{
      this.password.set('');
      this.submitting.set(false);
    }
  }

  async logout():Promise<void> {
    if(!this.signedIn()||this.logoutPending()||this.logoutUnconfirmed())return;
    this.lockSession('');
    this.logoutPending.set(true);
    this.logoutUnconfirmed.set(false);
    try{
      const result=await this.request<{ok:boolean}>('/logout','POST');
      if(result.ok!==true)throw Error('Saída não confirmada.');
      this.notice.set('Sessão encerrada no servidor.');
    }catch{
      this.logoutUnconfirmed.set(true);
      this.error.set('A interface foi bloqueada, mas o servidor não confirmou a saída. Tente encerrar a sessão novamente antes de deixar este dispositivo.');
    }finally{this.logoutPending.set(false);}
  }

  async retryLogout():Promise<void> {
    if(!this.logoutUnconfirmed()||this.logoutPending()||this.submitting())return;
    this.logoutPending.set(true);
    this.error.set('');
    try{
      const result=await this.request<{ok:boolean}>('/logout','POST');
      if(result.ok!==true)throw Error('Saída não confirmada.');
      this.logoutUnconfirmed.set(false);
      this.notice.set('Saída confirmada pelo servidor.');
    }catch{
      this.error.set('O servidor ainda não confirmou a saída. Verifique sua conexão e tente novamente.');
    }finally{this.logoutPending.set(false);}
  }

  async refresh(automatic=false):Promise<void>{
    if(this.loading()||!this.signedIn()||this.destroyed)return;
    const epoch=this.authEpoch;
    this.loading.set(true);this.error.set('');
    try{
      // Each source is independent; one failed service must not hide the other reading.
      const [metrics,containers]=await Promise.allSettled([
        this.request<unknown>('/overview'),this.request<unknown>('/containers')
      ]);
      if(epoch!==this.authEpoch||!this.signedIn()||this.destroyed)return;
      let failed=0;
      try{
        if(metrics.status==='rejected')throw metrics.reason;
        this.overview.set(parseOverview(metrics.value));
        this.overviewIssue.set('');
      }catch(error){failed++;this.overviewIssue.set(this.message(error));}
      try{
        if(containers.status==='rejected')throw containers.reason;
        this.inventory.set(parseInventory(containers.value));
        this.inventoryIssue.set('');
      }catch(error){failed++;this.inventoryIssue.set(this.message(error));}
      this.clock.set(Date.now());
      if(!automatic)this.notice.set(failed===0?'Métricas e inventário consultados com sucesso.':
        failed===1?'Consulta parcial: veja abaixo o que não respondeu.':
        'As duas consultas falharam. Dados anteriores, se houver, permanecem identificados.');
    }finally{if(epoch===this.authEpoch&&!this.destroyed)this.loading.set(false);}
  }

  selectPage(page: 'overview' | 'containers' | 'deployments' | 'apps' | 'projects' | 'terminal' | 'revisions' | 'database' | 'domains' | 'traffic' | 'secrets' | 'settings' | 'infrastructure'): void {
    this.page.set(page);
    this.menuOpen.set(false);
    if (window.location.hash !== '#' + page) window.location.hash = page;
    window.scrollTo(0, 0);
    this.focusPageTitle();
  }
  formatDate(value?: string): string {
    if (!value) return 'Sem leitura confirmada';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? 'Sem leitura confirmada' : d.toLocaleString('pt-BR');
  }
  gb(value?: number): string {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? (value / 1073741824).toFixed(1).replace('.', ',') + ' GB' : '—';
  }
  private message(error: unknown): string {
    return error instanceof Error ? error.message : 'Falha ao comunicar com a VPS.';
  }
}
