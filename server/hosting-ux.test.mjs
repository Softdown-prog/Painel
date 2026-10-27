import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('simple hosting navigation preserves technical view identifiers', () => {
  const html = file('index.html');
  for (const route of ['apps', 'projects', 'domains']) {
    assert.match(html, new RegExp('href="#' + route + '"'));
    assert.match(html, new RegExp('id="' + route + '"'));
  }
  for (const anchor of ['appCreateForm', 'domainCreateForm', 'domainAddressPreview', 'domainsHelp',
    'domainCaddyPreview', 'domainCreateButton']) {
    assert.match(html, new RegExp('id="' + anchor + '"'));
  }
  assert.match(html, /O que você quer fazer\?/);
  assert.match(html, /Sites e apps/);
  assert.match(html, /Ligar ao GitHub/);
  assert.match(html, /Escolher um endereço/);
  assert.match(html, /<details class="panel full-panel domain-technical">/);
  assert.match(html, /id="hostedProjects"/);
  assert.match(html, /hosted-projects-ui\.js/);
  assert.match(html, /DNS E HTTPS GUIADOS/);
});

test('domain and app shortcuts keep labels and real publication status', () => {
  const domains = file('domains-ui.ts');
  const apps = file('apps-ui.ts');
  assert.match(domains, /Endereço proposto/);
  assert.match(domains, /ainda não publicado/);
  assert.match(domains, /canCreate = result.enabled && eligible.length > 0/);
  assert.match(domains, /selectedFromApps/);
  assert.match(apps, /Ligar ao GitHub/);
  assert.match(apps, /Escolher endereço/);
  assert.match(apps, /panelSelectedAppSlug/);
});

test('Codex backlog records scaling and the production blockers without overstating delivery', () => {
  const backlog = file('docs/TAREFAS-CODEX.md');
  const agent = file('AGENTS.md');
  const guide = file('docs/GUIA-RAPIDO.md');
  for (const term of ['C01', 'C02', 'C03', 'C04', 'C07', 'múltiplas VPS', '8 aplicações']) {
    assert.ok(backlog.includes(term), 'Backlog must explain ' + term);
  }
  assert.match(backlog, /não significa colocar na internet|Não publica o site/i);
  assert.match(agent, /docs\/TAREFAS-CODEX\.md/);
  assert.match(guide, /Preparar ou reservar não significa colocar na internet/);
});

test('Serviços Softload mostra somente os dois containers centrais com ações seguras', () => {
  const api = file('server/api.mjs');
  const ui = file('script.js');
  const deploy = file('server/deploy-verification.mjs');
  const executor = file('server/executor-policy.ts');

  assert.match(api, /const controllable = new Set\(legacyEntries\.filter/);
  assert.match(api, /controllable: Boolean\(c\) && controllable\.has\(id\)/);
  assert.match(api, /const operation = .*\(app\|agent\).*start\|stop\|restart/);
  assert.match(api, /Serviço não cadastrado neste host/);
  const profile = file('server/legacy-softload-profile.ts');
  assert.match(profile, /softload-vps-app-1/);
  assert.match(profile, /softload-vps-agent-1/);
  assert.doesNotMatch(deploy, /sandbox:|embeddings:/);
  assert.doesNotMatch(executor, /softload-vps-sandbox-1|softload-vps-embeddings-1|softload-portainer/);

  // Reiniciar/Parar ocorre somente na tela Gerenciar; container inexistente não tem Iniciar.
  assert.match(ui, /manage\.addEventListener\('click'/);
  assert.match(ui, /service\.state === 'running' \? \[\['restart'/);
  assert.match(ui, /\['exited', 'created'\]\.includes\(service\.state\)/);
  assert.match(ui, /Atualizar registros/);
  assert.match(ui, /buttons\.forEach\(control => \{ control\.disabled = true;/);
});
