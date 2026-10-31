import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Executed only when publishing Pages. Fresh URLs prevent an old terminal
// script from being reused after the server-side SSH command limit changes.
const version = process.env.GITHUB_SHA?.slice(0, 12);
if (!version || !/^[a-f0-9]{12}$/.test(version)) {
  throw new Error('GITHUB_SHA is required to version Pages JS/CSS assets');
}
const file = join(process.env.PAGES_DIST_DIR || 'dist', 'index.html');
const html = readFileSync(file, 'utf8');
let count = 0;
const rewritten = html.replace(
  /((?:src|href)=")((?!https?:|\/\/|\/)[^"?#]+\.(?:js|css))"/g,
  (_match, prefix, asset) => {
    count++;
    return prefix + asset + '?v=' + version + '"';
  }
);
if (count < 10 || !rewritten.includes('terminal-ui.js?v=')) {
  throw new Error('Unexpected Pages HTML: static assets were not versioned');
}
writeFileSync(file, rewritten);
writeFileSync(join(process.env.PAGES_DIST_DIR || 'dist', 'release.json'), JSON.stringify({ sha: process.env.GITHUB_SHA }) + '\n');
console.log('Prepared ' + count + ' versioned static assets for Pages');
