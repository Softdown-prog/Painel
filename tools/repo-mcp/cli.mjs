#!/usr/bin/env node
import {RepoNavigator} from './indexer.mjs';
import {resolve} from 'node:path';
const command=process.argv[2]??'index';
const navigator=new RepoNavigator(resolve(process.env.REPO_MCP_ROOT||process.cwd()));
try{
 if(command==='index'){
  const index=await navigator.buildIndex();
  process.stdout.write(JSON.stringify({ok:true,...index.summary,indexFile:'.repo-mcp/index.json'})+'\n');
 }else if(command==='stats')process.stdout.write(JSON.stringify(await navigator.stats())+'\n');
 else {process.stderr.write('Usage: node tools/repo-mcp/cli.mjs [index|stats]\n');process.exitCode=2;}
}catch(e){process.stderr.write('Index failed: '+(e instanceof Error?e.message:'unknown')+'\n');process.exitCode=1;}
