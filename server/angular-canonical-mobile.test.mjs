import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html');
const script = html.match(/<!-- Angular is canonical;[\s\S]*?<script>([\s\S]*?)<\/script>/)?.[1];
function navigate(url) {
  assert.ok(script, 'Canonical boot script must exist');
  const location = new URL(url);
  let destination = null;
  let classicClass = false;
  runInNewContext(script, {
    location: {
      pathname: location.pathname, search: location.search, hash: location.hash,
      replace: value => { destination = value; }
    },
    URLSearchParams, Set,
    document: { documentElement: { classList: { add: value => { if (value === 'legacy-tools') classicClass = true; } } } }
  }, { timeout: 500 });
  return {destination,classicClass};
}

test('Angular is the only canonical entrypoint for desktop and mobile URLs', () => {
  assert.equal(navigate('https://panel.example.test/').destination,'/angular/#overview');
  assert.equal(navigate('https://panel.example.test/index.html').destination,'/angular/#overview');
  for (const [oldRoute,newRoute] of Object.entries({
    overview:'overview',containers:'containers',apps:'apps',deploys:'deployments',
    deployments:'deployments'
  })) {
    assert.equal(navigate('https://panel.example.test/#'+oldRoute).destination,
      '/angular/#'+newRoute);
  }
  assert.equal(navigate('https://panel.example.test/?interface=classica#overview').destination,
    '/angular/#overview','a second overview must not stay live');
  assert.equal(navigate('https://panel.example.test/#unknown').destination,'/angular/#overview');
});

test('advanced legacy tools stay available explicitly, without a second default dashboard', () => {
  for (const view of ['projects','terminal','database','revisions','domains','traffic','secrets','settings']) {
    assert.equal(navigate('https://panel.example.test/#'+view).destination,
      '/?interface=classica#'+view);
    const result = navigate('https://panel.example.test/?interface=classica#'+view);
    assert.equal(result.destination,null);
    assert.equal(result.classicClass,true);
  }
  assert.match(html,/Voltar ao painel principal/);
});

test('mobile navigation is tactile, responsive and deep-linkable', () => {
  const tpl = read('angular/src/app.component.html');
  const css = read('angular/src/app.component.css');
  const ts = read('angular/src/app.component.ts');
  const globalCss = read('angular/src/styles.css');
  assert.match(tpl,/class="mobile-tabs"/);
  const tabMarkup=tpl.slice(tpl.indexOf('class="mobile-tabs"'));
  for(const view of ['overview','containers','apps','deployments']){
    assert.ok(tabMarkup.includes("selectPage('"+view+"')"),'Missing mobile tab: '+view);
  }
  assert.match(tpl,/aria-controls="navigationPanel"/);
  assert.match(tpl,/aria-label="Fechar menu"/);
  assert.match(ts,/@HostListener\('window:hashchange'\)/);
  assert.match(ts,/@HostListener\('document:keydown.escape'\)/);
  assert.match(css,/@media \(max-width:900px\)/);
  assert.match(css,/safe-area-inset-bottom/);
  assert.match(css,/min-height:44px/);
  assert.match(css,/100dvh/);
  assert.match(globalCss,/overflow-x:clip/);
  assert.doesNotMatch(tpl,/href="\/#overview"/);
});

test('small screens keep apps, GitHub Actions cards and buttons inside viewport',()=>{
  const apps=read('angular/src/apps.component.css');
  const deploys=read('angular/src/deployments.component.css');
  assert.match(apps,/\.create-form \{ grid-template-columns:1fr/);
  assert.match(apps,/\.app-grid \{ grid-template-columns:1fr/);
  assert.match(apps,/\.logs pre \{ max-width:100%;overflow-x:auto/);
  assert.match(deploys,/\.pipeline \{ grid-template-columns:1fr/);
  assert.match(deploys,/\.live-controls \{ grid-template-columns:1fr/);
  assert.match(deploys,/min-height:44px/);
});
