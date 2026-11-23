import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOperation, tools, validateSchema } from '../src/tools.mjs';
import { wrapScript } from '../src/bridge.mjs';

function execute(operation, host) {
  let response;
  vm.runInNewContext(wrapScript(operation.code, 'TEST:'), {
    host,
    alert(value) { response = JSON.parse(value.slice('TEST:'.length)); },
  });
  return response;
}


function nativeDocument(overrides = {}) {
  return {
    Name: 'Drawing', FileName: '', FullFileName: '', Unit: 3,
    Pages: { Count: 1 }, ActiveLayer: {},
    ActivePage: { Name: 'Page 1', SizeWidth: 210, SizeHeight: 297, Shapes: { Count: 0 } },
    Selection() { return { Shapes: { Count: 0 } }; },
    BeginCommandGroup() {}, EndCommandGroup() {},
    ...overrides,
  };
}

function nativeHost(documents, extras = {}) {
  const host = {
    Documents: { Count: documents.length, Item(index) { return documents[index - 1]; } },
    ActiveDocument: documents[0], ...extras,
  };
  for (const doc of documents) doc.Activate = function () { host.ActiveDocument = this; };
  return host;
}

test('tool catalog has explicit schemas and no unbounded object serialization', () => {
  const names = tools.map(tool => tool.name);
  assert.ok(tools.length > 8);
  assert.equal(new Set(names).size, tools.length);
  for (const name of ['status', 'inspect_document', 'create_document', 'create_rectangle', 'create_ellipse', 'create_text', 'run_javascript', 'save_as']) {
    assert.ok(names.includes('coreldraw_' + name), 'Missing original tool: ' + name);
  }
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(typeof tool.description, 'string');
  }
});

test('Graphtec preparation validates explicit targeting and produces a local preparation action',async()=>{
  const operation=await buildOperation('coreldraw_prepare_graphtec_job',{document:'name:Stickers',outputPath:'/tmp/new.graphtec.json'});
  assert.equal(operation.graphtec.document,'name:Stickers');
  await assert.rejects(buildOperation('coreldraw_prepare_graphtec_job',{outputPath:'/tmp/new.graphtec.json'}),/document/);
  await assert.rejects(buildOperation('coreldraw_prepare_graphtec_job',{document:'name:Stickers',outputPath:'/tmp/new.json',send:true}),/Unknown argument/);
});

test('empty document inspection returns a bounded plain result', async () => {
  const operation = await buildOperation('coreldraw_inspect_document', {});
  assert.deepEqual(execute(operation, { Documents: { Count: 0 } }), {
    ok: true, result: { documentCount: 0, activeDocument: null },
  });
});

test('document inspection copies only scalar metadata from native objects', async () => {
  const doc = nativeDocument({ FullFileName: '/tmp/Drawing.cdr', Pages: { Count: 2 },
    ActivePage: { Name: 'Page 1', SizeWidth: 210, SizeHeight: 297, Shapes: { Count: 9 } },
    Selection() { return { Shapes: { Count: 2 } }; } });
  doc.circular = doc;
  const operation = await buildOperation('coreldraw_inspect_document', {});
  assert.deepEqual(execute(operation, nativeHost([doc])), {
    ok: true,
    result: { documentCount: 1, activeDocument: { id: 'path:/tmp/Drawing.cdr', name: 'Drawing', fileName: '', fullFileName: '/tmp/Drawing.cdr', unit: 3, pageCount: 2,
      activePage: { name: 'Page 1', width: 210, height: 297, shapeCount: 9 }, selectionCount: 2 } },
  });
});

test('text is encoded as data even when it contains JavaScript and unicode', async () => {
  const text = '\"; throw new Error("injected"); //\n日本語 🪵';
  const calls = [];
  const shape = { StaticID: 7, Type: 6 };
  const operation = await buildOperation('coreldraw_create_text', { x: 1, y: 2, text });
  const doc = nativeDocument({ ActiveLayer: { CreateArtisticText(...args) { calls.push(args); return shape; } } });
  const result = execute(operation, nativeHost([doc]));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [[1, 2, text]]);
  assert.equal(result.result.shapeId, 7);
});

test('rectangle dimensions use current units without changing them', async () => {
  const calls = [];
  const operation = await buildOperation('coreldraw_create_rectangle', { x: -2, y: 3, width: 10, height: 20 });
  const doc = nativeDocument({ Unit: 1, ActiveLayer: { CreateRectangle2(...args) { calls.push(args); return { StaticID: 1, Type: 1 }; } } });
  const result = execute(operation, nativeHost([doc]));
  assert.equal(doc.Unit, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [[-2, 3, 10, 20]]);
});

test('ellipse uses left top right bottom coordinates', async () => {
  const calls = [];
  const operation = await buildOperation('coreldraw_create_ellipse', { x: 2, y: 3, width: 10, height: 20 });
  const doc = nativeDocument({ ActiveLayer: { CreateEllipse(...args) { calls.push(args); return { StaticID: 2, Type: 2 }; } } });
  assert.equal(execute(operation, nativeHost([doc])).ok, true);
  assert.deepEqual(calls, [[2, 23, 12, 3]]);
});

test('new document sets millimeter units and requested page size', async () => {
  const calls = [];
  const doc = nativeDocument({ Name: 'MCP test', Unit: 0, ActivePage: {
    Name: 'Page 1', Shapes: { Count: 0 },
    SetSize(...args) { calls.push(args); this.SizeWidth = args[0]; this.SizeHeight = args[1]; },
  } });
  const operation = await buildOperation('coreldraw_create_document', { name: 'MCP test', width: 210, height: 297 });
  const result = execute(operation, {
    CreateStructCreateOptions() { return { Name: '' }; },
    CreateDocument(...args) { assert.equal(args.length, 0); throw new Error('Use CreateDocumentEx for named documents'); },
    CreateDocumentEx(options) { assert.equal(options.Name, 'MCP test'); return doc; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.width, 210);
  assert.equal(result.result.height, 297);
  assert.equal(doc.Unit, 3);
  assert.deepEqual(calls, [[210, 297]]);
});

test('shape tools fail when no document is open and return Corel errors', async () => {
  const operation = await buildOperation('coreldraw_create_rectangle', { x: 0, y: 0, width: 10, height: 5 });
  const result = execute(operation, { Documents: { Count: 0 } });
  assert.equal(result.ok, false);
  assert.match(result.error, /document/i);
  assert.deepEqual(execute({ code: 'throw new Error("Corel failed");' }, {}), { ok: false, error: 'Corel failed' });
});

test('script result is valid JSON even when body returns undefined', () => {
  assert.deepEqual(execute({ code: 'return undefined;' }, {}), { ok: true, result: null });
});

test('validation rejects unknown tool, bad arguments and code', async () => {
  await assert.rejects(buildOperation('not_a_tool', {}), /Unknown tool/);
  await assert.rejects(buildOperation('coreldraw_status', { unused: true }), /Unknown argument/);
  await assert.rejects(buildOperation('coreldraw_create_rectangle', { x: 0, y: 0, width: 0, height: 1 }), /width/);
  await assert.rejects(buildOperation('coreldraw_create_text', { x: 0, y: 0, text: 42 }), /text/);
  await assert.rejects(buildOperation('coreldraw_run_javascript', { code: 'return {' }), /JavaScript/);
  await assert.rejects(buildOperation('coreldraw_status', []), /object/);
});

test('save refuses existing files, relative paths and missing parents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'corel-save-test-'));
  try {
    const path = join(dir, 'already.cdr');
    await writeFile(path, 'existing');
    await assert.rejects(buildOperation('coreldraw_save_as', { document: 'name:Drawing', path }), /exists/);
    const link = join(dir, 'dangling.cdr');
    await symlink(join(dir, 'other-target'), link);
    await assert.rejects(buildOperation('coreldraw_save_as', { document: 'name:Drawing', path: link }), /exists/);
    await assert.rejects(buildOperation('coreldraw_save_as', { document: 'name:Drawing', path: 'relative.cdr' }), /absolute/);
    await assert.rejects(buildOperation('coreldraw_save_as', { document: 'name:Drawing', path: join(dir, 'missing', 'drawing.cdr') }), /parent/);
    await assert.rejects(buildOperation('coreldraw_save_as', { document: 'name:Drawing', path: join(dir, 'drawing.pdf') }), /\.cdr/);
    const target = join(dir, 'new.cdr');
    const calls = [];
    const operation = await buildOperation('coreldraw_save_as', { document: 'name:Drawing', path: target });
    const doc = nativeDocument({ SaveAs(p, options) { assert.equal(options.Overwrite, false); this.FullFileName = p; calls.push(p); } });
    assert.equal(execute(operation, nativeHost([doc], {
      CreateStructSaveAsOptions() { return { Overwrite: true }; },
    })).ok, true);
    assert.deepEqual(calls, [target]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('native save options refuse a target created after Node preflight', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'corel-save-race-test-'));
  try {
    const path = join(dir, 'race.cdr');
    const operation = await buildOperation('coreldraw_save_as', { document: 'name:Drawing', path });
    await writeFile(path, 'original');
    const doc = nativeDocument({ SaveAs(p, options) {
      assert.equal(p, path);
      if (options?.Overwrite === false) throw new Error('Target exists; save failed');
      throw new Error('Unsafe overwrite was requested');
    } });
    const result = execute(operation, nativeHost([doc], {
      CreateStructSaveAsOptions() { return { Overwrite: true }; },
    }));
    assert.equal(result.ok, false);
    assert.match(result.error, /Target exists; save failed/);
    assert.doesNotMatch(result.error, /Unsafe overwrite was requested/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('structured creation resolves an explicit document and closes one undo group', async () => {
  const events = [];
  const first = nativeDocument({ Name: 'First' });
  const second = nativeDocument({ Name: 'Second', ActiveLayer: {
    CreateRectangle2(...args) { events.push(['rectangle', ...args]); return { StaticID: 22, Type: 1 }; },
  }, BeginCommandGroup(label) { events.push(['begin', label]); }, EndCommandGroup() { events.push(['end']); } });
  const host = nativeHost([first, second]);
  Object.defineProperty(host, 'ActiveLayer', { get() { throw new Error('Global layer must not receive target edits'); } });
  const operation = await buildOperation('coreldraw_create_rectangle', { document: 'name:Second', x: 1, y: 2, width: 3, height: 4 });
  const result = execute(operation, host);
  assert.equal(result.ok, true);
  assert.equal(result.result.shapeId, 22);
  assert.equal(host.ActiveDocument, second);
  assert.deepEqual(events, [['begin', 'MCP rectangle'], ['rectangle', 1, 2, 3, 4], ['end']]);
});

test('ambiguous mutation is rejected before changing either open document', async () => {
  const calls = [];
  const first = nativeDocument({ Name: 'First', BeginCommandGroup() { calls.push('begin'); } });
  const second = nativeDocument({ Name: 'Second' });
  const operation = await buildOperation('coreldraw_create_rectangle', { x: 0, y: 0, width: 2, height: 2 });
  const host = nativeHost([first, second]);
  const result = execute(operation, host);
  assert.equal(result.ok, false);
  assert.match(result.error, /explicit document/i);
  assert.equal(host.ActiveDocument, first);
  assert.deepEqual(calls, []);
});

test('native mutation failure closes its command group and explains partial edits', async () => {
  const events = [];
  const doc = nativeDocument({ ActiveLayer: { CreateArtisticText() { throw new Error('Font engine failed'); } },
    BeginCommandGroup() { events.push('begin'); }, EndCommandGroup() { events.push('end'); } });
  const operation = await buildOperation('coreldraw_create_text', { x: 0, y: 0, text: 'Label' });
  const result = execute(operation, nativeHost([doc]));
  assert.equal(result.ok, false);
  assert.match(result.error, /Font engine failed/);
  assert.match(result.error, /partial.*Undo/i);
  assert.deepEqual(events, ['begin', 'end']);
});

test('recursive validation rejects fractional ids and malformed nested batch records', async () => {
  const valid = { sourceId: 1, records: [{ replacements: [{ name: 'Title', text: 'Oak' }] }], offsetX: 5, offsetY: 0 };
  for (const sourceId of [1.5, '1', NaN, Infinity]) {
    await assert.rejects(buildOperation('coreldraw_personalize_batch', { ...valid, sourceId }), /sourceId/);
  }
  await assert.rejects(buildOperation('coreldraw_personalize_batch', { ...valid, records: [{ replacements: [{ name: 'Title', text: 42 }] }] }), /records\[0\]\.replacements\[0\]\.text/);
  await assert.rejects(buildOperation('coreldraw_personalize_batch', { ...valid, records: [{ replacements: [{ name: 'Title' }] }] }), /text/);
  await assert.rejects(buildOperation('coreldraw_personalize_batch', { ...valid, records: [{ replacements: [{ name: 'Title', text: 'Oak', script: 'unexpected' }] }] }), /Unknown argument.*script/);
  await assert.rejects(buildOperation('coreldraw_personalize_batch', { ...valid, records: [{ replacements: null }] }), /replacements/);
  assert.doesNotThrow(() => validateSchema({ type: 'integer', minimum: 1 }, 2));
});
