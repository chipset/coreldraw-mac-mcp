import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorelBridge } from '../src/bridge.mjs';

async function fixture(t, code) {
  const dir = await mkdtemp(join(tmpdir(), 'corel-helper-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = join(dir, 'helper.mjs');
  await writeFile(helper, '#!/usr/bin/env node\n' + code, { mode: 0o700 });
  return { dir, helper };
}

test('bridge executes wrapped scripts and cleans temporary request files', async t => {
  const { dir, helper } = await fixture(t, `
    import {readFileSync} from 'node:fs';
    import vm from 'node:vm';
    const [,bundle,path,prefix] = process.argv.slice(2);
    vm.runInNewContext(readFileSync(path,'utf8'), {host:{}, alert(value){ console.log(value.slice(prefix.length)); }});
  `);
  const bridge = new CorelBridge({ helper, tempRoot: dir });
  assert.deepEqual(await bridge.run('return {value: 42};'), { value: 42 });
  assert.deepEqual(await readdir(dir), ['helper.mjs']);
});

test('native failures and malformed responses surface clearly', async t => {
  const a = await fixture(t, 'console.log(JSON.stringify({ok:false,error:"Accessibility permission required"})); process.exitCode=1;');
  await assert.rejects(new CorelBridge({ helper: a.helper }).status(), /Accessibility permission/);
  const b = await fixture(t, 'console.log("not json");');
  await assert.rejects(new CorelBridge({ helper: b.helper }).status(), /invalid JSON/i);
});

test('bridge kills timed out helpers and marks execution outcome uncertain', async t => {
  const { helper } = await fixture(t, 'setTimeout(() => {},10000);');
  const bridge = new CorelBridge({ helper, timeoutSeconds: 0.05, timeoutGraceMs: 0 });
  await assert.rejects(bridge.run('return 1;'), /timed out.*may have.*executed/i);
});

test('queued requests run serially', async t => {
  const { dir, helper } = await fixture(t, `
    import {appendFileSync} from 'node:fs';
    const path=${JSON.stringify('EVENTS')};
    appendFileSync(path,'start\\n');
    setTimeout(()=>{appendFileSync(path,'end\\n'); console.log(JSON.stringify({ok:true,result:1}));},30);
  `.replace(JSON.stringify('EVENTS'), JSON.stringify(join(tmpdir(), 'unused'))));
  const events = join(dir, 'events');
  let source = await readFile(helper, 'utf8');
  source = source.replace(JSON.stringify(join(tmpdir(), 'unused')), JSON.stringify(events));
  await writeFile(helper, source);
  const bridge = new CorelBridge({ helper });
  await Promise.all([bridge.run('return 1;'), bridge.run('return 2;')]);
  assert.equal(await readFile(events, 'utf8'), 'start\nend\nstart\nend\n');
});

test('failed calls do not poison the queue and cancelled queued scripts do not execute', async t => {
  const { dir, helper } = await fixture(t, `
    import {existsSync, writeFileSync} from 'node:fs';
    const path=${JSON.stringify('MARKER')};
    const failed = !existsSync(path);
    writeFileSync(path, 'called');
    setTimeout(()=>console.log(JSON.stringify(failed ? {ok:false,error:'First failure'} : {ok:true,result:42})),30);
  `);
  const marker = join(dir, 'marker');
  await writeFile(helper, (await readFile(helper, 'utf8')).replace(JSON.stringify('MARKER'), JSON.stringify(marker)));
  const bridge = new CorelBridge({ helper });
  const first = bridge.run('return 1;');
  const firstRejected = assert.rejects(first, /First failure/);
  const controller = new AbortController();
  const cancelled = bridge.run('throw new Error("must not run");', { signal: controller.signal });
  const cancelledRejected = assert.rejects(cancelled, /cancelled before execution/);
  controller.abort();
  const third = bridge.run('return 42;');
  await Promise.all([firstRejected, cancelledRejected]);
  assert.equal(await third, 42);
});

test('cancelling a started helper keeps observing it and holds the execution queue', async t => {
  const { dir, helper } = await fixture(t, `
    import {appendFileSync} from 'node:fs';
    const path=${JSON.stringify('EVENTS')};
    appendFileSync(path,'start\\n');
    setTimeout(()=>{appendFileSync(path,'end\\n'); console.log(JSON.stringify({ok:true,result:42}));},100);
  `);
  const events = join(dir, 'events');
  await writeFile(helper, (await readFile(helper, 'utf8')).replace(JSON.stringify('EVENTS'), JSON.stringify(events)));
  const bridge = new CorelBridge({ helper });
  const controller = new AbortController();
  const first = bridge.run('return 42;', { signal: controller.signal });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await readFile(events, 'utf8')).includes('start')) break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  controller.abort();
  const second = bridge.run('return 42;');
  assert.equal(await first, 42);
  assert.equal(await second, 42);
  assert.equal(await readFile(events, 'utf8'), 'start\nend\nstart\nend\n');
});

const mimeType = Buffer.from('application/x-vnd.corel.zcf.draw.document+zip');
function cdrZipHeader() {
  const header = Buffer.alloc(38);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE(mimeType.length, 18);
  header.writeUInt32LE(mimeType.length, 22);
  header.writeUInt16LE(8, 26);
  header.write('mimetype', 30);
  return Buffer.concat([header, mimeType]);
}

test('save postflight refuses silent no-save even when a racing target has a CDR header', async t => {
  const { dir, helper } = await fixture(t, 'PLACEHOLDER');
  const savePath = join(dir, 'target.cdr');
  await writeFile(helper, `#!/usr/bin/env node\n
    import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(savePath)}, Buffer.from(${JSON.stringify(cdrZipHeader().toString('hex'))},'hex'));
    console.log(JSON.stringify({ok:true,result:{path:${JSON.stringify(savePath)},fullFileName:'/tmp/original.cdr',previousFullFileName:'/tmp/original.cdr'}}));
  `);
  await assert.rejects(new CorelBridge({ helper }).run('return null;', { savePath }), /Save not verified.*associated/i);
});

test('save postflight verifies actual Corel ZIP MIME header and returns disk size', async t => {
  const { dir, helper } = await fixture(t, 'PLACEHOLDER');
  const savePath = join(dir, 'target.cdr');
  const bytes = cdrZipHeader();
  await writeFile(helper, `#!/usr/bin/env node\n
    import {writeFileSync} from 'node:fs';
    const path=${JSON.stringify(savePath)};
    writeFileSync(path,Buffer.from(${JSON.stringify(bytes.toString('hex'))},'hex'));
    console.log(JSON.stringify({ok:true,result:{path,fullFileName:path,previousFullFileName:''}}));
  `);
  const result = await new CorelBridge({ helper }).run('return null;', { savePath });
  assert.equal(result.savedBytes, bytes.length);
  assert.equal(result.fileFormat, 'corel-zip');
});

test('save postflight rejects missing, empty and non-Corel output', async t => {
  for (const data of [null, '', 'CORELDRAW_MCP_OVERWRITE_SENTINEL', 'PK\\x03\\x04 not a Corel document']) {
    const { dir, helper } = await fixture(t, 'PLACEHOLDER');
    const savePath = join(dir, 'target.cdr');
    await writeFile(helper, `#!/usr/bin/env node\n
      import {writeFileSync} from 'node:fs';
      const path=${JSON.stringify(savePath)};
      ${data === null ? '' : `writeFileSync(path,${JSON.stringify(data)});`}
      console.log(JSON.stringify({ok:true,result:{path,fullFileName:path,previousFullFileName:''}}));
    `);
    await assert.rejects(new CorelBridge({ helper }).run('return null;', { savePath }), /Save not verified/i);
  }
});

test('save postflight accepts legacy RIFF CDR and refuses unchanged native association', async t => {
  const { dir, helper } = await fixture(t, 'PLACEHOLDER');
  const savePath = join(dir, 'target.cdr');
  // Explicit bytes avoid JS source escape ambiguity in the native helper fixture.
  const riff = Buffer.concat([Buffer.from('RIFF'), Buffer.from([8,0,0,0]), Buffer.from('CDR9DATA')]);
  await writeFile(helper, `#!/usr/bin/env node\n
    import {writeFileSync} from 'node:fs';
    const path=${JSON.stringify(savePath)};
    writeFileSync(path,Buffer.from(${JSON.stringify(riff.toString('hex'))},'hex'));
    console.log(JSON.stringify({ok:true,result:{path,fullFileName:path,previousFullFileName:''}}));
  `);
  assert.equal((await new CorelBridge({ helper }).run('return null;', { savePath })).fileFormat, 'riff-cdr');
  const secondPath = join(dir, 'second.cdr');
  await writeFile(helper, `#!/usr/bin/env node\n
    import {writeFileSync} from 'node:fs';
    const path=${JSON.stringify(secondPath)};
    writeFileSync(path,Buffer.from(${JSON.stringify(riff.toString('hex'))},'hex'));
    console.log(JSON.stringify({ok:true,result:{path,fullFileName:path,previousFullFileName:path}}));
  `);
  await assert.rejects(new CorelBridge({ helper }).run('return null;', { savePath: secondPath }), /Save not verified.*already associated/i);
});

test('pinned save rejects a valid file from the wrong source document', async t => {
  const { dir, helper } = await fixture(t, 'PLACEHOLDER');
  const savePath = join(dir, 'target.cdr');
  await writeFile(helper, `#!/usr/bin/env node\n
    import {writeFileSync} from 'node:fs';
    const path=${JSON.stringify(savePath)};
    writeFileSync(path,Buffer.from(${JSON.stringify(cdrZipHeader().toString('hex'))},'hex'));
    console.log(JSON.stringify({ok:true,result:{fullFileName:path,previousFullFileName:'',sourceDocument:{id:'name:Wrong',name:'Wrong',fullFileName:''},document:{id:'path:'+path,fullFileName:path},shapeCountBefore:2,shapeCountAfter:2}}));
  `);
  await assert.rejects(new CorelBridge({ helper }).run('return null;', { savePath, expectedDocument: 'name:Art' }), /source document/i);
});

test('export verifies format bytes and publishes without clobbering a racing file', async t => {
  const { dir, helper } = await fixture(t, `
    import {readFileSync,writeFileSync} from 'node:fs';
    import vm from 'node:vm';
    const [,bundle,path,prefix] = process.argv.slice(2);
    vm.runInNewContext(readFileSync(path,'utf8'), {writeFileSync,Buffer,alert(value){ console.log(value.slice(prefix.length)); }});
  `);
  const bridge = new CorelBridge({ helper, tempRoot: dir });
  const exportPath = join(dir, 'preview.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4coAAAAASUVORK5CYII=', 'base64').toString('hex');
  const code = `writeFileSync(__corelOutputPath,Buffer.from('${png}','hex'));return {exportedPath:__corelOutputPath};`;
  const result = await bridge.run(code, { exportPath, format: 'png', preview: true });
  assert.equal(result.exportedBytes, png.length / 2);
  assert.equal(result.previewPath, exportPath);
  assert.equal((await readFile(exportPath)).toString('hex'), png);
  const racedPath = join(dir, 'raced.png');
  await assert.rejects(bridge.run(`writeFileSync(${JSON.stringify(racedPath)},'user sentinel');${code}`, { exportPath: racedPath, format: 'png' }), /already exists|EEXIST/i);
  assert.equal(await readFile(racedPath, 'utf8'), 'user sentinel');
  const wrongPath = join(dir, 'wrong.pdf');
  await assert.rejects(bridge.run(code, { exportPath: wrongPath, format: 'pdf' }), /Export not verified/i);
  assert.deepEqual((await readdir(dir)).sort(), ['helper.mjs', 'preview.png', 'raced.png']);
});

test('export rejects truncated files and validates PDF and SVG signatures', async t => {
  const { dir, helper } = await fixture(t, `
    import {readFileSync,writeFileSync} from 'node:fs';
    import vm from 'node:vm';
    const [,bundle,path,prefix] = process.argv.slice(2);
    vm.runInNewContext(readFileSync(path,'utf8'), {writeFileSync,Buffer,alert(value){ console.log(value.slice(prefix.length)); }});
  `);
  const bridge = new CorelBridge({ helper, tempRoot: dir });
  for (const [format, content] of [['pdf', '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n'], ['svg', '<svg/>']]) {
    const result = await bridge.run(`writeFileSync(__corelOutputPath,${JSON.stringify(content)});return {exportedPath:__corelOutputPath};`, { exportPath: join(dir, 'valid.' + format), format });
    assert.equal(result.format, format);
  }
  for (const [format, content] of [['png', '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'], ['pdf', Buffer.from('%PDF-1.7\nmissing end marker').toString('hex')], ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path').toString('hex')]]) {
    await assert.rejects(bridge.run(`writeFileSync(__corelOutputPath,Buffer.from('${content}','hex'));return {exportedPath:__corelOutputPath};`, { exportPath: join(dir, 'truncated.' + format), format }), /Export not verified/i);
  }
});

test('pinned save rejects changed object counts even with a valid file', async t => {
  const { dir, helper } = await fixture(t, 'PLACEHOLDER');
  const savePath = join(dir, 'target.cdr');
  await writeFile(helper, `#!/usr/bin/env node\n
    import {writeFileSync} from 'node:fs';
    const path=${JSON.stringify(savePath)};
    writeFileSync(path,Buffer.from(${JSON.stringify(cdrZipHeader().toString('hex'))},'hex'));
    console.log(JSON.stringify({ok:true,result:{fullFileName:path,previousFullFileName:'',sourceDocument:{id:'name:Art',name:'Art',fullFileName:''},document:{id:'path:'+path,fullFileName:path},shapeCountBefore:2,shapeCountAfter:3}}));
  `);
  await assert.rejects(new CorelBridge({ helper }).run('return null;', { savePath, expectedDocument: 'name:Art' }), /shape count/i);
});
