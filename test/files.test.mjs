import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileTools, buildFileOperation } from '../src/files.mjs';
async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'corel-files-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function execute(body, context) { return vm.runInNewContext(`(function(){${body}})()`, context); }

test('file tools expose bounded schemas and save requires a document selector', () => {
  assert.equal(fileTools.length, 4);
  const save = fileTools.find(t => t.name === 'coreldraw_save_as');
  assert.ok(save.inputSchema.required.includes('document'));
  assert.equal(save.inputSchema.additionalProperties, false);
});

test('save pins source identity and confirms object count and native association', async t => {
  const dir = await directory(t), path = join(dir, 'art.cdr');
  const args = { document: 'name:Art', path };
  const operation = await buildFileOperation('coreldraw_save_as', args);
  assert.ok(operation);
  const doc = { Name: 'Art', FullFileName: '', ActivePage: { Shapes: { Count: 2 } }, SaveAs(target, options) { assert.equal(options.Overwrite, false); this.FullFileName = target; } };
  const result = execute(operation.body, { args, doc, page: doc.ActivePage, host: { CreateStructSaveAsOptions: () => ({}) }, describeDocument: d => ({ id: d.FullFileName ? 'path:' + d.FullFileName : 'name:' + d.Name, name: d.Name, fullFileName: d.FullFileName }) });
  assert.equal(result.sourceDocument.id, 'name:Art');
  assert.equal(result.document.id, 'path:' + path);
  assert.equal(result.shapeCountBefore, 2);
  assert.equal(result.shapeCountAfter, 2);
  assert.equal(operation.savePath, path);
  await assert.rejects(buildFileOperation('coreldraw_save_as', { path }), /document/i);
  await writeFile(path, 'sentinel');
  await assert.rejects(buildFileOperation('coreldraw_save_as', args), /already exists/i);
});

test('import requires newly selected object IDs and detects silent native no-op', async t => {
  const dir = await directory(t), path = join(dir, 'art.svg'); await writeFile(path, '<svg/>');
  const args = { path };
  const operation = await buildFileOperation('coreldraw_import_file', args);
  assert.ok(operation);
  const items = [{ StaticID: 4 }];
  const shapes = { get Count() { return items.length; }, Item(i) { return items[i - 1]; } };
  const doc = { selected: { Count: 0, Item() {} }, Selection() { return { Shapes: this.selected }; } };
  const importOptions = {};
  const context = { args, doc, host: { CreateStructImportOptions: () => importOptions }, page: { Shapes: shapes }, layer: { Import() {} }, describeShape: s => ({ id: s.StaticID }) };
  assert.throws(() => execute(operation.body, context), /import.*no new|import.*not verif/i);
  context.layer.Import = (path, filter, options) => { assert.equal(filter, 1345); assert.equal(options, importOptions); assert.equal(options.LinkBitmapExternally, false); const s = { StaticID: 5 }; items.push(s); doc.selected = { Count: 1, Item: () => s }; };
  const result = execute(operation.body, context);
  assert.equal(result.importedCount, 1);
  assert.equal(result.shapes[0].id, 5);
});

test('exports use staging output and documented format-specific methods', async t => {
  const dir = await directory(t);
  for (const format of ['png', 'pdf', 'svg']) {
    const args = { path: join(dir, 'art.' + format), format };
    const operation = await buildFileOperation('coreldraw_export_file', args);
    assert.ok(operation);
    const calls = [], exportOptions = {}, paletteOptions = {};
    const host = { CreateStructExportOptions: () => exportOptions, CreateStructPaletteOptions: () => paletteOptions };
    const doc = { PublishToPDF(...a) { calls.push(['pdf', ...a]); }, Export(...a) { calls.push([format, ...a]); } };
    const result = execute(operation.body, { args, host, doc, __corelOutputPath: '/private/stage.' + format, describeDocument: () => ({ id: 'name:Art' }) });
    assert.equal(result.exportedPath, '/private/stage.' + format);
    assert.equal(calls[0][0], format);
    assert.equal(calls[0][1], '/private/stage.' + format);
    if (format !== 'pdf') {
      assert.equal(calls[0][2], format === 'png' ? 802 : 1345);
      assert.equal(calls[0][3], 1);
      assert.equal(calls[0][4], exportOptions);
      assert.equal(calls[0][5], paletteOptions);
      assert.equal(exportOptions.Overwrite, false);
    }
    if (format === 'png') {
      assert.equal(exportOptions.ImageType, 4);
      assert.equal(exportOptions.ResolutionX, 144);
      assert.equal(exportOptions.AntiAliasingType, 1);
      assert.equal(exportOptions.Transparent, false);
    }
    assert.equal(operation.exportPath, args.path);
    assert.equal(operation.format, format);
  }
  await assert.rejects(buildFileOperation('coreldraw_export_file', { path: join(dir, 'bad.png'), format: 'pdf' }), /extension/i);
  const preview = await buildFileOperation('coreldraw_preview', { path: join(dir, 'preview.png') });
  assert.equal(preview.preview, true);
  assert.equal(preview.format, 'png');
});

test('native methods may be callable even when a JS typeof lookup reports undefined', async t => {
  const dir = await directory(t);
  const op = await buildFileOperation('coreldraw_export_file', { path: join(dir, 'art.svg'), format: 'svg' });
  // Corel native methods are not reflected as JavaScript functions; generated
  // code must invoke them and report an unsupported failure on invocation.
  assert.doesNotMatch(op.body, /typeof\s+doc\.Export/);
  assert.throws(() => execute(op.body, { args: {}, host: {}, doc: {}, __corelOutputPath: '/tmp/stage.svg' }), /SVG export.*unsupported/i);
});
