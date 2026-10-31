import { Component, OnInit, computed, signal } from '@angular/core';

type Session = {authenticated: boolean; setupRequired: boolean};
type Summary = {available: boolean; running: number | null; total: number | null; truncated?: boolean};
type Overview = {
  containerSummary?: Summary;
  cpu?: {load1: number; cores: number};
  memory?: {used?: number; total?: number};
  disk?: {used: number; total: number};
  updatedAt?: string;
};
type ManagedContainer = {
  name?: string; image?: string; state?: string; status?: string;
  project?: string; ownership?: string;
};
type Inventory = {containers?: ManagedContainer[]; readOnly?: boolean; updatedAt?: string; truncated?: boolean};

@Component({
  selector: 'panel-app',
  standalone: true,
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit {
  readonly page = signal<'overview' | 'containers'>('overview');
  readonly session = signal<Session | null>(null);
  readonly overview = signal<Overview | null>(null);
  readonly inventory = signal<Inventory | null>(null);
  readonly loading = signal(false);
  readonly submitting = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly username = signal('admin');
  readonly password = signal('');
  readonly activeContainers = computed(() =>
    (this.inventory()?.containers ?? []).filter(c => c.state === 'running').length);
  readonly signedIn = computed(() => this.session()?.authenticated === true);

  async ngOnInit(): Promise<void> { await this.checkSession(); }

  async request<T>(path: string, method = 'GET', payload?: object): Promise<T> {
    // The VPS web gateway keeps x-panel-edge-key only on the server. Never store it here.
    const response = await fetch('/api' + path, {
      method, headers: payload ? {'content-type': 'application/json'} : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
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
    this.error.set('');
    try {
      const session = await this.request<Session>('/session');
      if (typeof session.authenticated !== 'boolean' || typeof session.setupRequired !== 'boolean')
        throw new Error('Não foi possível validar a sessão administrativa.');
      this.session.set(session);
      if (session.authenticated) await this.refresh();
    } catch (err) { this.error.set(this.message(err)); }
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
    this.error.set('');
    try { await this.request('/logout', 'POST'); }
    catch (err) { this.error.set(this.message(err)); }
    this.session.set({authenticated:false,setupRequired:false});
    this.overview.set(null);
    this.inventory.set(null);
    this.password.set('');
  }

  async refresh(): Promise<void> {
    if (this.loading() || !this.signedIn()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const [overview, inventory] = await Promise.all([
        this.request<Overview>('/overview'), this.request<Inventory>('/containers')
      ]);
      if (inventory.readOnly !== true || !Array.isArray(inventory.containers))
        throw new Error('O inventário da VPS está indisponível.');
      this.overview.set(overview);
      this.inventory.set(inventory);
      this.notice.set('Dados atualizados da VPS');
    } catch (err) {
      this.error.set(this.message(err));
      this.notice.set('Não foi possível atualizar; dados anteriores mantidos.');
    } finally { this.loading.set(false); }
  }

  selectPage(page: 'overview' | 'containers'): void { this.page.set(page); }
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
