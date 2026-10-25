const services = [
  { name: 'Backend principal', detail: 'API e aplicação web', icon: 'S' },
  { name: 'Solaris Code', detail: 'Assistente de código', icon: '✳' },
  { name: 'Agent Worker', detail: 'Processamento de tarefas', icon: '◇' },
  { name: 'Asset Forge', detail: 'Geração de recursos', icon: '◈' },
  { name: 'Sandbox', detail: 'Execução isolada', icon: '▣' },
  { name: 'Embeddings', detail: 'Busca semântica', icon: '⌁' }
];

function serviceRow(service) {
  const row = document.createElement('div');
  row.className = 'service-row';
  const symbol = document.createElement('span');
  symbol.className = 'service-symbol';
  symbol.textContent = service.icon;
  const main = document.createElement('span');
  main.className = 'service-main';
  const title = document.createElement('strong');
  title.textContent = service.name;
  const detail = document.createElement('small');
  detail.textContent = service.detail;
  main.append(title, detail);
  const state = document.createElement('span');
  state.className = 'service-state';
  const dot = document.createElement('span');
  dot.className = 'dot green';
  state.append(dot, 'Exemplo');
  const more = document.createElement('span');
  more.className = 'service-more';
  more.textContent = '⋯';
  row.append(symbol, main, state, more);
  return row;
}

services.slice(0, 4).forEach(service => document.getElementById('overviewServices').append(serviceRow(service)));
services.forEach(service => document.getElementById('allServices').append(serviceRow(service)));

const menu = document.getElementById('sidebar');
const menuButton = document.getElementById('menuButton');
function showView(name) {
  const view = document.getElementById(name) || document.getElementById('overview');
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el === view));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view.id));
  document.getElementById('currentCrumb').textContent = view.dataset.title;
  menu.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
  document.title = `${view.dataset.title} — Softload Console`;
}
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
showView(location.hash.slice(1));
menuButton.addEventListener('click', () => {
  const open = menu.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
});

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}
document.querySelectorAll('.demo-action').forEach(button => button.addEventListener('click', () => toast(`${button.dataset.action}: disponível após conectar login e API da VPS.`)));
document.getElementById('infoButton').addEventListener('click', () => toast('Esta é uma prévia visual. Os indicadores são exemplos e nenhuma ação alcança a VPS.'));
document.getElementById('bannerClose').addEventListener('click', () => document.querySelector('.demo-banner').remove());
document.getElementById('logFilter').addEventListener('change', () => toast('Filtros de logs serão ativados com a API da VPS.'));
