// Local static fixture for the browser suite. No VPS/API proxy, deployments or credentials.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..');
const bundle = resolve(repository, 'angular/dist/panel-angular/browser');
const port = 4175;
const mime = {
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml',
  '.ico':'image/x-icon',
  '.woff2':'font/woff2'
};
const server = createServer(async (req,res)=>{
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname.startsWith('/api/')) {
    res.writeHead(503, {'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({error:'API mock não configurada: somente testes interceptados podem consultar /api'}));
    return;
  }
  let base;
  let relative;
  if (pathname==='/' || pathname==='/index.html') {
    base = repository;
    relative = 'index.html';
  } else if (pathname==='/angular' || pathname==='/angular/') {
    base = bundle;
    relative = 'index.html';
  } else if (pathname.startsWith('/angular/')) {
    base = bundle;
    relative = pathname.slice('/angular/'.length);
  } else {
    res.writeHead(404);res.end('Not found');return;
  }
  let file;
  try {
    file = resolve(base, decodeURIComponent(relative));
    if (!file.startsWith(base+sep) || !(await stat(file)).isFile()) throw Error('Invalid path');
    const data=await readFile(file);
    res.writeHead(200,{'content-type':mime[extname(file)]??'application/octet-stream',
      'cache-control':'no-store','x-content-type-options':'nosniff'});
    res.end(data);
  } catch {
    res.writeHead(404);res.end('Not found');
  }
});
server.listen(port, '127.0.0.1');
