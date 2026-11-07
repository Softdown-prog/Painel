import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html');
const script = html.match(/<script>([\\s\\S]*?)<\\/script>/)?.[1];
function navigate(url) {
  assert.ok(script, 'The root must redirect to canonical Angular');
  const location = new URL(url);
  let destination = null;
  runInNewContext(script, {
    location: {
      hash: location.hash, replace: value => { destination = value; }
    },
    URLSearchParams, Set
  }, { timeout: 500 });
  return destination;
}

test('only Angular UI is served from the root, preserving useful old deep links',()=>{
  assert.equal(navigate('https://panel.test/'),'/angular/#overview');
  assert.equal(navigate('https://panel.test/?interface=classica#overview'),'/angular/#overview');
  for (const [oldRoute, newRoute] of Object.entries({
    overview:'overview',containers:'containers',apps:'apps',projects:'projects',terminal:'terminal',
    agents:'agents',revisions:'revisions',database:'database',domains:'domains',traffic:'traffic',
    secrets:'secrets',settings:'settings',infrastructure:'infrastructure',deployments:'deployments',
    deploys:'deployments',services:'containers',logs:'terminal'
  })){
    assert.equal(navigate('https://panel.test/#'+oldRoute),'/angular/#'+newRoute);
    assert.equal(navigate('https://panel.test/?interface=classica#'+oldRoute),'/angular/#'+newRoute);
  }
  assert.equal(navigate('https://panel.test/#unknown'),'/angular/#overview');
  assert.equal(navigate('https://panel.test/#site?slug=my-site'),'/angular/#site?slug=my-site');
  assert.equal(navigate('https://panel.test/#site?slug=../bad'),'/angular/#apps');
  assert.doesNotMatch(html, /<link[^>]+\\.css|<script[^>]+src=/i,'No secondary frontend assets');
  assert.doesNotMatch(html,/legacy-tools|data-view|id="sidebar"/);
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
  assert.match(deploys,/\.pipeline\s*\{\s*grid-template-columns:1fr/);
  assert.match(deploys,/\.live-controls \{ grid-template-columns:1fr/);
  assert.match(deploys,/min-height:44px/);
});
