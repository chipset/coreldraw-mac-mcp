import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function client(t, helperBody = 'console.log(JSON.stringify({ok:true,running:true,accessibilityTrusted:false}));') {
  const dir = await mkdtemp(join(tmpdir(), 'corel-mcp-test-'));
  const helper = join(dir, 'helper.mjs');
  await writeFile(helper, '#!/usr/bin/env node\n'+helperBody, { mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    env: { ...process.env, CORELDRAW_HELPER: helper }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); await rm(dir, { recursive: true, force: true }); });
  const waiting = new Map();
  const messages = [];
  let data = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    data += chunk;
    while (data.includes('\n')) {
      const pos = data.indexOf('\n');
      const msg = JSON.parse(data.slice(0, pos));
      data = data.slice(pos + 1);
      messages.push(msg);
      waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let id = 0;
  const send = (method, params = {}) => {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No MCP response: ' + stderr)), 3000);
      waiting.set(requestId, message => { clearTimeout(timer); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
  };
  return { child, send, messages, waiting, dir };
}

test('MCP initializes, lists all tools, serves real helper status and ping', async t => {
  const c = await client(t);
  const init = await c.send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } });
  c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const catalog = await c.send('tools/list');
  assert.ok(catalog.result.tools.length > 8);
  assert.equal(new Set(catalog.result.tools.map(tool => tool.name)).size, catalog.result.tools.length);
  assert.ok(catalog.result.tools.some(tool => tool.name === 'coreldraw_list_documents'));
  const status = await c.send('tools/call', { name: 'coreldraw_status', arguments: {} });
  assert.equal(status.result.isError, false);
  assert.equal(JSON.parse(status.result.content[0].text).accessibilityTrusted, false);
  assert.deepEqual((await c.send('ping')).result, {});
  assert.equal(c.messages.length, 4);
});

test('MCP serves migration reference and the actual tool schemas without native execution',async t=>{
  const c=await client(t, 'throw new Error("Native helper must not run for resources");');
  await c.send('initialize');
  const resources=await c.send('resources/list');
  assert.ok(resources.result.resources.some(r=>r.uri==='coreldraw://reference'));
  const reference=await c.send('resources/read',{uri:'coreldraw://reference'});
  assert.match(reference.result.contents[0].text,/StaticID/);
  assert.match(reference.result.contents[0].text,/document/);
  const catalog=await c.send('resources/read',{uri:'coreldraw://tools'});
  const listed=await c.send('tools/list');
  assert.deepEqual(JSON.parse(catalog.result.contents[0].text),listed.result.tools);
  assert.equal((await c.send('resources/read',{uri:'coreldraw://missing'})).error.code,-32602);
});

test('MCP rejects pre-initialization calls and invalid tools without losing session', async t => {
  const c = await client(t);
  assert.equal((await c.send('tools/list')).error.code, -32002);
  assert.equal((await c.send('initialize', { protocolVersion: 'unknown' })).result.protocolVersion, '2025-11-25');
  assert.equal((await c.send('missing/method')).error.code, -32601);
  const bad = await c.send('tools/call', { name: 'coreldraw_create_rectangle', arguments: { x: 0, y: 0, width: -1, height: 1 } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /width/);
  assert.equal((await c.send('tools/call', { name: 'coreldraw_status', arguments: null })).result.isError, true);
  assert.ok((await c.send('tools/list')).result.tools.length > 8);
});

test('MCP parse errors are JSON-RPC errors and notifications produce no response', async t => {
  const c = await client(t);
  const response = new Promise(resolve => c.waiting.set(null, resolve));
  c.child.stdin.write('malformed\n');
  assert.equal((await response).error.code, -32700);
  c.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  assert.deepEqual((await c.send('ping')).result, {});
  assert.equal(c.messages.length, 2);
});

test('MCP preserves partial-edit evidence and marks failed batches as errors', async t => {
  const partial={status:'partial',partial:true,failedIndex:1,completed:[{shapeId:7}],error:'Native failure',notAttempted:2};
  const c=await client(t,'console.log('+JSON.stringify(JSON.stringify({ok:true,result:partial}))+');');
  await c.send('initialize');
  const response=await c.send('tools/call',{name:'coreldraw_scene_batch',arguments:{document:'name:Test',scenes:[{template:'sign'}]}});
  assert.equal(response.result.isError,true);
  assert.deepEqual(JSON.parse(response.result.content[0].text),partial);
});

test('MCP preview returns verified PNG bytes as an image content block', async t => {
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mGsAAAAASUVORK5CYII=';
  const c=await client(t,`import {readFileSync,writeFileSync} from 'node:fs';
    const script=readFileSync(process.argv[4],'utf8');
    const path=JSON.parse(script.match(/var __corelOutputPath = (.*);/)[1]);
    writeFileSync(path,Buffer.from('${png}','base64'));
    console.log(JSON.stringify({ok:true,result:{exportedPath:path}}));`);
  await c.send('initialize');
  const response=await c.send('tools/call',{name:'coreldraw_preview',arguments:{document:'name:Test',path:join(c.dir,'preview.png'),width:1,height:1}});
  assert.equal(response.result.isError,false);
  assert.equal(response.result.content[1].type,'image');
  assert.equal(response.result.content[1].mimeType,'image/png');
  assert.equal(response.result.content[1].data,png);
  assert.equal(JSON.parse(response.result.content[0].text).pixelWidth,1);
});
