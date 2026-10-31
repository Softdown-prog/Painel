import { Component, HostListener, OnInit, computed, signal } from '@angular/core';
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
import { validAppSlug } from './apps-policy';
import {parseOverview,parseInventory,type HostOverview,type HostInventory} from './overview-state';

type Session = {authenticated: boolean; setupRequired: boolean};
@Component({
  selector: 'panel-app',
  standalone: true,
  imports: [DeploymentsComponent, AppsComponent, GithubProjectsComponent, TerminalComponent, RevisionsComponent, PostgresComponent, DomainsComponent, TrafficComponent, SecretsComponent, SettingsComponent, LegacyServicesComponent, SiteDetailComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit {
  readonly page = signal<'overview' | 'containers' | 'deployments' | 'apps' | 'projects' | 'terminal' | 'revisions' | 'database' | 'domains' | 'traffic' | 'secrets' | 'settings' | 'site'>('overview');
  readonly selectedSiteSlug=signal<string|null>(null);
  readonly menuOpen = signal(false);
  readonly session = signal<Session | null>(null);
  readonly overview = signal<HostOverview | null>(null);
  readonly inventory = signal<HostInventory | null>(null);
  readonly overviewIssue=signal('');
  readonly inventoryIssue=signal('');
  private authEpoch=0;
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
    await this.checkSession();
  }

  @HostListener('window:hashchange')
  onRouteChange(): void {
    this.syncPageFromLocation();
    this.menuOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void { this.menuOpen.set(false); }

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
        hash === 'secrets' || hash === 'settings') this.page.set(hash);
    else this.page.set('overview');
  }

  toggleMenu(): void { this.menuOpen.update(open => !open); }
  closeMenu(): void { this.menuOpen.set(false); }


  async request<T>(path: string, method = 'GET', payload?: object): Promise<T> {
    // The VPS web gateway keeps x-panel-edge-key only on the server. Never store it here.
    const response = await fetch('/api' + path, {
      method, ...(payload ? {headers: {'content-type':'application/json'},body:JSON.stringify(payload)} : {}),
      credentials: 'same-origin', redirect: 'error', cache: 'no-store'
    });
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('A API da VPS devolveu uma resposta inesperada.');
    if (!response.ok) {
      const obj = data as {error?: unknown};
      throw new Error(typeof obj.error === 'string' ? obj.error : 'A API não respondeu (HTTP ' + response.status + ').');
    }
    return data as T;
  }

  async checkSession(): Promise<void> {
    const epoch=this.authEpoch;
    this.error.set('');
    try {
      const session=await this.request<Session>('/session');
      if(epoch!==this.authEpoch)return;
      if(typeof session.authenticated!=='boolean'||typeof session.setupRequired!=='boolean')
        throw Error('Não foi possível validar a sessão administrativa.');
      this.session.set(session);
      if(session.authenticated)await this.refresh();
      else{this.authEpoch++;this.clearReadings();}
    }catch(error){if(epoch===this.authEpoch)this.error.set(this.message(error));}
  }

  private clearReadings():void{
    this.overview.set(null);this.inventory.set(null);
    this.overviewIssue.set('');this.inventoryIssue.set('');
    this.loading.set(false);this.notice.set('');
  }

  prepareSetup(event:Event):void{
    event.preventDefault();
    if(this.submitting()||!this.session()?.setupRequired||!this.setupValid())return;
    this.error.set('');this.setupPending.set(true);
  }

  cancelSetup():void{
    this.setupToken.set('');this.setupPassword.set('');this.setupRepeat.set('');
    this.setupPending.set(false);
  }

  async completeSetup():Promise<void>{
    if(!this.setupPending()||!this.session()?.setupRequired||!this.setupValid()||this.submitting())return;
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
    if (this.submitting()) return;
    this.submitting.set(true);
    this.error.set('');
    try {
      await this.request<{ok: boolean}>('/login', 'POST', {
        username: this.username().trim(), password: this.password()
      });
      this.password.set('');
      await this.checkSession();
    } catch (err) { this.error.set(this.message(err)); }
    finally { this.submitting.set(false); }
  }

  async logout(): Promise<void> {
    this.authEpoch++;
    this.error.set('');
    this.session.set({authenticated:false,setupRequired:false});
    this.clearReadings();
    this.password.set('');
    this.cancelSetup();
    this.menuOpen.set(false);
    try{await this.request('/logout','POST');}
    catch{this.error.set('Não foi possível confirmar a saída no servidor. Tente novamente antes de deixar o dispositivo.');}
  }

  async refresh():Promise<void>{
    if(this.loading()||!this.signedIn())return;
    const epoch=this.authEpoch;
    this.loading.set(true);this.error.set('');
    try{
      // Each source is independent; one failed service must not hide the other reading.
      const [metrics,containers]=await Promise.allSettled([
        this.request<unknown>('/overview'),this.request<unknown>('/containers')
      ]);
      if(epoch!==this.authEpoch||!this.signedIn())return;
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
      this.notice.set(failed===0?'Métricas e inventário consultados com sucesso.':
        failed===1?'Consulta parcial: veja abaixo o que não respondeu.':
        'As duas consultas falharam. Dados anteriores, se houver, permanecem identificados.');
    }finally{if(epoch===this.authEpoch)this.loading.set(false);}
  }

  selectPage(page: 'overview' | 'containers' | 'deployments' | 'apps' | 'projects' | 'terminal' | 'revisions' | 'database' | 'domains' | 'traffic' | 'secrets' | 'settings'): void {
    this.page.set(page);
    this.menuOpen.set(false);
    if (window.location.hash !== '#' + page) window.location.hash = page;
    window.scrollTo(0, 0);
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
