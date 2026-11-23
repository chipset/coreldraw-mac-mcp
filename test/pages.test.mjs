import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { documentScript } from '../src/document.mjs';
import { validateSchema } from '../src/tools.mjs';
import { pageTools, buildPageOperation } from '../src/pages.mjs';
const collection = items => ({ get Count() { return items.length; }, Item(index) { return items[index - 1]; } });

function fixture() {
  const events = [], documents = [];
  const host = { Documents: collection(documents) };
  function document(Name) {
    const pages = [];
    const doc = { Name, FullFileName: '', Unit: 3, Pages: collection(pages),
      Activate() { host.ActiveDocument = doc; },
      BeginCommandGroup(label) { events.push(['begin', Name, label]); }, EndCommandGroup() { events.push(['end', Name]); },
      AddPages(count) { for (let i = 0; i < count; i++) addPage(); },
    };
    function addPage() {
      const layers = [];
      const page = { Index: pages.length + 1, Name: `Page ${pages.length + 1}`, SizeWidth: 210, SizeHeight: 297,
        Shapes: collection([]), Layers: collection(layers),
        Activate() { doc.ActivePage = page; doc.ActiveLayer = layers[0]; },
        SetSize(width, height) { page.SizeWidth = width; page.SizeHeight = height; },
      };
      for (const name of ['Artwork', 'Cut lines']) {
        const layer = { Name: name, Visible: true, Editable: true, Printable: true, Shapes: collection([]),
          Activate() { doc.ActiveLayer = layer; },
        };
        layers.push(layer);
      }
      pages.push(page);
      return page;
    }
    addPage().Activate();
    addPage();
    documents.push(doc);
    return doc;
  }
  const first = document('existing'), target = document('target');
  host.ActiveDocument = first;
  return { host, first, target, events };
}

function run(suffix, args = {}, context = fixture()) {
  const tool = pageTools.find(item => item.name === `coreldraw_${suffix}`);
  assert.ok(tool, `${suffix} tool must exist`);
  validateSchema(tool.inputSchema, args);
  const operation = buildPageOperation(tool.name, args);
  assert.ok(operation, `${suffix} operation must exist`);
  const result = vm.runInNewContext(`(function(){${documentScript({ document: 'name:target', ...args }, operation.body, operation)}\n})()`, { host: context.host });
  return JSON.parse(JSON.stringify(result));
}

test('page catalog exposes all seven bounded tools without a document schema', () => {
  assert.deepEqual(pageTools.map(item => item.name).sort(), [
    'coreldraw_activate_layer', 'coreldraw_activate_page', 'coreldraw_add_pages', 'coreldraw_list_pages',
    'coreldraw_rename_page', 'coreldraw_set_layer_properties', 'coreldraw_set_page_size',
  ]);
  assert.equal(buildPageOperation('other_tool', {}), null);
  for (const tool of pageTools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.document, undefined);
    assert.equal(tool.annotations.readOnlyHint, tool.name === 'coreldraw_list_pages');
  }
});

test('schema rejects invalid counts, indices, dimensions and flag values', () => {
  for (const [suffix, args] of [
    ['add_pages', { count: 0 }], ['add_pages', { count: 101 }], ['add_pages', { count: 1.5 }],
    ['activate_page', { index: 0 }], ['activate_page', { index: 1.1 }],
    ['set_page_size', { width: 0, height: 2 }], ['set_page_size', { width: 2, height: Infinity }],
    ['rename_page', { name: '' }], ['activate_layer', { name: '' }],
    ['set_layer_properties', { name: 'Artwork', visible: 'true' }],
    ['list_pages', { offset: -1 }], ['list_pages', { offset: 0.5 }],
    ['list_pages', { limit: 0 }], ['list_pages', { limit: 101 }], ['list_pages', { limit: 1.5 }],
  ]) {
    const schema = pageTools.find(item => item.name === `coreldraw_${suffix}`)?.inputSchema;
    assert.ok(schema, `${suffix} schema must exist`);
    assert.throws(() => validateSchema(schema, args));
  }
});

test('page listing reads the explicit target and leaves active document unchanged', () => {
  const context = fixture();
  const result = run('list_pages', {}, context);
  assert.equal(result.pageCount, 2);
  assert.equal(result.activePageIndex, 1);
  assert.deepEqual(result.pages.map(page => [page.index, page.name, page.width, page.height]), [[1, 'Page 1', 210, 297], [2, 'Page 2', 210, 297]]);
  assert.equal(result.truncated, false);
  assert.equal(result.nextOffset, null);
  assert.equal(context.host.ActiveDocument, context.first);
  assert.deepEqual(context.events, []);
});

test('page listing bounds each host enumeration to 100 pages and returns resumable offsets', () => {
  const context = fixture(), original = context.target.Pages;
  let maximum = 0;
  context.target.Pages = { Count: 1001, Item(index) { maximum = Math.max(maximum, index); return { ...original.Item(1), Index: index }; } };
  const result = run('list_pages', {}, context);
  assert.equal(result.pages.length, 100);
  assert.equal(result.pageCount, 1001);
  assert.equal(result.truncated, true);
  assert.equal(maximum, 100);
  assert.equal(result.nextOffset, 100);
  const later = run('list_pages', { offset: 998, limit: 2 }, context);
  assert.deepEqual(later.pages.map(page => page.index), [999, 1000]);
  assert.equal(later.nextOffset, 1000);
  assert.equal(later.truncated, true);
  const last = run('list_pages', { offset: 1000, limit: 100 }, context);
  assert.deepEqual(last.pages.map(page => page.index), [1001]);
  assert.equal(last.nextOffset, null);
  assert.equal(last.truncated, false);
  const beyond = run('list_pages', { offset: 2000 }, context);
  assert.deepEqual(beyond.pages, []);
  assert.equal(beyond.nextOffset, null);
  assert.equal(beyond.truncated, false);
});

test('native Unicode and escaped-control page names stay below the bridge response budget', () => {
  for (const nativeName of ['漢'.repeat(255), '\u0000'.repeat(255), '😀'.repeat(127) + '\u0000', '\u0001'.repeat(300000)]) {
    const context = fixture(), original = context.target.Pages.Item(1);
    context.target.Pages = { Count: 1000, Item(index) { return { ...original, Index: index, Name: nativeName }; } };
    const result = run('list_pages', {}, context);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 200 * 1024);
    assert.equal(result.pages.length, 100);
    assert.equal(result.pages[0].name, nativeName.slice(0, 255));
    assert.equal(result.pages[0].nameTruncated, nativeName.length > 255);
    assert.equal(result.nextOffset, 100);
  }
});

test('page activation bounds unusually long existing native names without renaming them', () => {
  const context = fixture(), page = context.target.Pages.Item(2);
  page.Name = '漢'.repeat(300);
  const result = run('activate_page', { index: 2 }, context);
  assert.equal(result.name, '漢'.repeat(255));
  assert.equal(result.nameTruncated, true);
  assert.equal(page.Name.length, 300);
});

test('adding pages defaults to one and verifies actual count on the explicit document', () => {
  const context = fixture();
  assert.equal(run('add_pages', {}, context).pageCount, 3);
  assert.equal(run('add_pages', { count: 2 }, context).pageCount, 5);
  assert.equal(context.first.Pages.Count, 2);
  context.target.AddPages = () => {};
  assert.throws(() => run('add_pages', { count: 1 }, context), /page.*count|add.*verif/i);
  assert.equal(context.events.at(-1)[0], 'end');
});

test('activation checks page index before activation and verifies active-page readback', () => {
  const context = fixture();
  assert.throws(() => run('activate_page', { index: 3 }, context), /page.*index|page.*not found/i);
  assert.equal(context.target.ActivePage.Index, 1);
  assert.equal(run('activate_page', { index: 2 }, context).index, 2);
  assert.equal(context.target.ActivePage.Index, 2);
  context.target.Pages.Item(1).Activate = () => {};
  assert.throws(() => run('activate_page', { index: 1 }, context), /activation.*verif|active page.*mismatch/i);
});

test('page sizing supports explicit and active page targets with readback', () => {
  const context = fixture();
  assert.equal(run('set_page_size', { index: 2, width: 100, height: 50 }, context).width, 100);
  assert.equal(context.target.ActivePage.SizeWidth, 210);
  assert.equal(run('set_page_size', { width: 80, height: 60 }, context).height, 60);
  context.target.ActivePage.SetSize = () => {};
  assert.throws(() => run('set_page_size', { width: 20, height: 30 }, context), /size.*verif|size.*mismatch/i);
  assert.throws(() => run('set_page_size', { index: 99, width: 20, height: 30 }, context), /page.*index|page.*not found/i);
  assert.equal(context.target.ActivePage.SizeWidth, 80);
});

test('page rename supports explicit and active targets and rejects silently ignored setters', () => {
  const context = fixture();
  assert.equal(run('rename_page', { index: 2, name: 'Back' }, context).name, 'Back');
  assert.equal(run('rename_page', { name: 'Front' }, context).name, 'Front');
  Object.defineProperty(context.target.ActivePage, 'Name', { get: () => 'Front', set() {} });
  assert.throws(() => run('rename_page', { name: 'Ignored' }, context), /name.*verif|name.*mismatch/i);
});

test('exact layer activation rejects missing and ambiguous names before activation', () => {
  const context = fixture();
  assert.throws(() => run('activate_layer', { name: 'artwork' }, context), /not found/i);
  assert.equal(context.target.ActiveLayer.Name, 'Artwork');
  assert.equal(run('activate_layer', { name: 'Cut lines' }, context).name, 'Cut lines');
  context.target.ActivePage.Layers.Item(1).Name = 'Cut lines';
  assert.throws(() => run('activate_layer', { name: 'Cut lines' }, context), /ambiguous/i);
});

test('layer activation verifies the actual active layer', () => {
  const context = fixture();
  context.target.ActivePage.Layers.Item(2).Activate = () => {};
  assert.throws(() => run('activate_layer', { name: 'Cut lines' }, context), /activation.*verif|active layer.*mismatch/i);
});

test('layer properties update requested flags only and keep existing active layer', () => {
  const context = fixture();
  const result = run('set_layer_properties', { name: 'Cut lines', visible: false, editable: false }, context);
  assert.equal(result.visible, false);
  assert.equal(result.editable, false);
  assert.equal(result.printable, true);
  assert.equal(context.target.ActiveLayer.Name, 'Artwork');
  assert.equal(run('set_layer_properties', { name: 'Cut lines', printable: false }, context).printable, false);
});

test('layer properties preflight empty edits, ambiguity and unavailable flags before assignment', () => {
  const context = fixture(), layer = context.target.ActivePage.Layers.Item(2);
  assert.throws(() => run('set_layer_properties', { name: 'Cut lines' }, context), /at least one|property.*required/i);
  assert.throws(() => run('set_layer_properties', { name: 'missing', visible: false }, context), /not found/i);
  layer.Editable = undefined;
  assert.throws(() => run('set_layer_properties', { name: 'Cut lines', visible: false, editable: false }, context), /editable.*unavailable|unsupported.*editable/i);
  assert.equal(layer.Visible, true);
  context.target.ActivePage.Layers.Item(1).Name = 'Cut lines';
  assert.throws(() => run('set_layer_properties', { name: 'Cut lines', visible: false }, context), /ambiguous/i);
  assert.equal(layer.Visible, true);
});

test('layer properties fail on ignored setters and close the undo group', () => {
  const context = fixture(), layer = context.target.ActivePage.Layers.Item(2);
  Object.defineProperty(layer, 'Printable', { get: () => true, set() {} });
  assert.throws(() => run('set_layer_properties', { name: 'Cut lines', printable: false }, context), /printable.*verif|printable.*mismatch/i);
  assert.equal(context.events.at(-1)[0], 'end');
});
