import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const root = new URL('../',import.meta.url);
const file = path => readFileSync(new URL(path,root),'utf8');

test('the root and Angular TypeScript projects enforce strict indexed and exact optional types',()=>{
  for (const path of ['tsconfig.json','angular/tsconfig.json']) {
    const {compilerOptions: ts} = JSON.parse(file(path));
    for (const flag of ['strict','noUncheckedIndexedAccess','exactOptionalPropertyTypes',
      'noImplicitOverride','noFallthroughCasesInSwitch',
      'noUnusedLocals','noUnusedParameters','noImplicitReturns','noPropertyAccessFromIndexSignature']) {
      assert.equal(ts[flag],true,`${path} must enable ${flag}`);
    }
  }
  const {angularCompilerOptions: ng} = JSON.parse(file('angular/tsconfig.app.json'));
  for (const flag of ['strictTemplates','strictInjectionParameters','strictInputAccessModifiers']) {
    assert.equal(ng[flag],true);
  }
});

test('the Angular frontend build remains part of isolated CI, never production deploys from migration branch',()=>{
  const ci=file('.github/workflows/ci.yml');
  const web=file('web/Dockerfile');
  assert.match(ci,/feat\/angular-complete-migration/);
  assert.match(ci,/Build independent VPS frontend image/);
  assert.match(web,/ng build|npm run build/);
  for(const path of ['.github/workflows/deploy-vps.yml','.github/workflows/deploy-pages.yml']) {
    assert.doesNotMatch(file(path),/feat\/angular-complete-migration/);
  }
});

test('ESLint flat config enforces safe TypeScript rules across the repository',()=>{
  const config=file('eslint.config.js');
  const pkg=JSON.parse(file('package.json'));
  assert.equal(pkg.scripts.lint,'eslint "**/*.ts"');
  for(const rule of ['@typescript-eslint/no-explicit-any','@typescript-eslint/no-unused-vars',
    '@typescript-eslint/explicit-function-return-type','no-console'])assert.ok(config.includes(rule));
  assert.match(file('.github/workflows/ci.yml'),/npm run lint/);
});
