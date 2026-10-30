import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const transport = readFileSync(new URL('../api-client.js', import.meta.url), 'utf8');
export function runPanelUi(source, context) {
  const scope = {AbortController, Headers, URL, setTimeout, clearTimeout, ...context,
    location: {origin: 'https://panel.test', ...context.location}};
  runInNewContext(transport + '\n' + source, scope);
  return scope;
}
