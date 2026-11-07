import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const file=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Angular dashboard requests authenticated live host metrics without demonstration values',()=>{
 const html=file('angular/src/app.component.html');
 const code=file('angular/src/app.component.ts');
 const state=file('angular/src/overview-state.ts');
 assert.match(html,/Containers em execução/);
 assert.match(html,/Disco em uso/);
 assert.match(html,/selectPage\('containers'\)/);
 assert.match(html,/refresh\(\)/);
 assert.match(code,/readingFresh\(/);
 assert.match(code,/parseOverview/);
 assert.match(state,/containerSummary/);
 assert.match(state,/readOnly:true/);
 assert.doesNotMatch(html,/demoServices|fillServices/);
});
test('Angular container inventory is read-only and lists every returned container',()=>{
 const html=file('angular/src/app.component.html');
 const code=file('angular/src/app.component.ts');
 const filters=file('angular/src/inventory-view.ts');
 assert.match(html,/page\(\) === 'containers'/);
 assert.match(html,/visibleContainers\(\)/);
 assert.match(html,/item\.name/);
 assert.match(html,/item\.project/);
 assert.match(code,/parseInventory/);
 assert.match(filters,/return inventory\.containers\.filter/);
 assert.doesNotMatch(html,/\/containers\/[^'" ]*(start|stop|restart|delete)/);
});
