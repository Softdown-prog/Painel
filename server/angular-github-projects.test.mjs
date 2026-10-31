import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Angular includes GitHub projects page and keeps existing maintenance tools',()=>{
  const app=read('angular/src/app.component.ts');
  const html=read('angular/src/app.component.html');
  const root=read('index.html');
  assert.match(app,/GithubProjectsComponent/);
  assert.match(app,/hash === 'projects'/);
  assert.match(html,/<panel-github-projects\s*\/>/);
  assert.match(html,/selectPage\('projects'\)/);
  assert.match(root,/projects:'projects'/);
  assert.match(root,/fragment === 'projects'/);
  assert.match(html,/selectPage\('terminal'\)/);
  assert.match(html,/\?interface=classica#database/);
});

test('GitHub mobile component keeps credential server-side and requires explicit publication confirmation',()=>{
  const code=read('angular/src/github-projects.component.ts');
  const html=read('angular/src/github-projects.component.html');
  assert.match(code,/fetch\('\/api'\+path/);
  assert.match(code,/credentials:'same-origin'/);
  assert.match(code,/validForm=computed/);
  assert.match(code,/action=signal<'deploy'\|'disconnect'\|null>/);
  assert.match(code,/startAction\(action:'deploy'\|'disconnect'\)/);
  assert.match(code,/async confirm\(\)/);
  assert.match(code,/this\.tokenConfigured\(\)/);
  assert.match(html,/Confirmar publicação/);
  assert.match(html,/Confirmar solicitação/);
  assert.match(html,/Confirmar remoção/);
  assert.match(html,/\(click\)="cancelAction\(\)"/);
  assert.ok(code.includes("this.api('/repositories','POST'"));
  assert.doesNotMatch(code,/localStorage|sessionStorage|GITHUB_TOKEN|Bearer /);
  assert.doesNotMatch(html,/type="password"|Insira seu token/);
});

test('GitHub projects panel remains usable on narrow mobile screens',()=>{
  const css=read('angular/src/github-projects.component.css');
  const html=read('angular/src/github-projects.component.html');
  assert.match(css,/@media\(max-width:480px\)/);
  assert.match(css,/min-height:44px/);
  assert.match(css,/overflow-wrap:anywhere/);
  assert.match(css,/\.connect-form\{grid-template-columns:1fr\}/);
  assert.match(html,/aria-pressed/);
  assert.match(html,/role="alert"/);
  assert.match(html,/role="status"/);
  assert.match(html,/rel="noopener noreferrer"/);
});
