import assert from 'node:assert/strict';
const sha = process.env.EXPECTED_SHA;
assert.match(sha || '', /^[0-9a-f]{40}$/);
let last;
for (let attempt = 0; attempt < 24; attempt++) {
  try {
    const base = 'https://panel.analysepro.com';
    const release = await fetch(`${base}/release.json?sha=${sha}`, { signal: AbortSignal.timeout(15000) });
    assert.equal(release.status, 200);
    assert.equal((await release.json()).sha, sha);
    const homepage = await fetch(`${base}/?sha=${sha}`, { signal: AbortSignal.timeout(15000) });
    assert.equal(homepage.status,200);
    const homepageHtml = await homepage.text();
    assert.match(homepageHtml,/location\.replace\('\/angular\/'/);
    const angular = await fetch(`${base}/angular/?sha=${sha}`, { signal: AbortSignal.timeout(15000) });
    assert.equal(angular.status, 200);
    const html = await angular.text();
    assert.ok(html.includes('<panel-app'));
    const script = /src="([^"\s]+\.js)"/.exec(html)?.[1];
    assert.ok(script, 'Angular bundle missing');
    const bundle = await fetch(new URL(script, base + '/angular/'), { signal: AbortSignal.timeout(15000) });
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type') || '', /javascript/);
    const api = await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(15000) });
    assert.equal(api.status, 200);
    assert.equal(typeof (await api.json()).authenticated, 'boolean');
    console.log(`Verified public Pages SHA ${sha}, Angular JS and real API session`);
    process.exit(0);
  } catch (error) { last = error; }
  await new Promise(resolve => setTimeout(resolve, 5000));
}
throw last;
