import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { inspectionTools, buildInspectionOperation } from '../src/inspection.mjs';
import { validateSchema } from '../src/tools.mjs';
import { documentScript } from '../src/document.mjs';

const collection = values => ({ Count: values.length, Item(i) { return values[i - 1]; } });
const shape = (id, extra = {}) => ({ StaticID: id, Name: `shape-${id}`, Type: 1, LeftX: 0, BottomY: 0, SizeWidth: 25.4, SizeHeight: 25.4, ...extra });
const curve = (id, closed = true) => shape(id, { Type: 3, Curve: { Nodes: collection([{ PositionX: 1, PositionY: 2, Type: 0, IsEnding: true }, { PositionX: 3, PositionY: 4, Type: 1, IsEnding: false }]), SubPaths: collection([{ Closed: closed }, { Closed: true }]) } });
function fixture(shapes = [], unit = 3) {
  const events = [];
  const doc = { Name: 'Test', FullFileName: '', Unit: unit, ActivePage: { Name: 'Page', Shapes: collection(shapes) }, ActiveLayer: {}, Activate() { events.push('activate'); }, BeginCommandGroup() { events.push('begin'); }, EndCommandGroup() { events.push('end'); } };
  const host = { Documents: collection([doc]), ActiveDocument: doc };
  return { host, events, doc };
}
function run(suffix, args = {}, state = fixture()) {
  const name = `coreldraw_${suffix}`, tool = inspectionTools.find(item => item.name === name);
  assert.ok(tool, `${name} exists`);
  validateSchema(tool.inputSchema, args);
  const operation = buildInspectionOperation(name, args);
  assert.equal(operation.mutates, false);
  const result = vm.runInNewContext(`(function(){${documentScript(args, operation.body, operation)}\n})()`, { host: state.host });
  assert.deepEqual(state.events, []);
  return JSON.parse(JSON.stringify(result));
}

test('inspection catalog validates bounded queries and requires integer curve StaticID', () => {
  assert.equal(buildInspectionOperation('unrelated', {}), null);
  assert.equal(inspectionTools.length, 3);
  for (const tool of inspectionTools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.document, undefined);
  }
  for (const args of [{}, { id: 1.5 }, { id: 1, limit: 1001 }]) assert.throws(() => run('inspect_curve', args));
  assert.throws(() => run('find_objects', { limit: 501 }));
  assert.throws(() => run('production_preflight', { minDpi: Infinity }));
});

test('find recurses groups, combines literal name/native type/text filters and returns scalar IDs', () => {
  const target = shape(2, { Type: 6, Name: 'Member title', Text: { Story: { Text: 'Hello BURN' } } });
  const group = shape(1, { Type: 7, Shapes: collection([target, shape(3)]) });
  const result = run('find_objects', { name: 'TITLE', type: 6, text: 'burn' }, fixture([group]));
  assert.deepEqual(result.objects.map(item => item.shapeId), [2]);
  assert.equal(result.objects[0].parentId, 1);
  assert.equal(result.objects[0].text, 'Hello BURN');
  assert.equal(result.truncated, false);
  assert.equal(result.incomplete, false);
  assert.deepEqual(run('find_objects', { name: 'TITLE', caseSensitive: true }, fixture([group])).objects, []);
});

test('find explicitly reports result, traversal and depth bounds without reading unbounded collections', () => {
  assert.equal(run('find_objects', { limit: 1 }, fixture([shape(1), shape(2)])).truncated, true);
  const bounded = run('find_objects', { name: 'missing', maxShapes: 1 }, fixture([shape(1), shape(2)]));
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.incomplete, true);
  let deep = shape(40);
  for (let i = 39; i > 0; i--) deep = shape(i, { Type: 7, Shapes: collection([deep]) });
  const result = run('find_objects', {}, fixture([deep]));
  assert.equal(result.incomplete, true);
  assert.ok(result.scanned <= 31);
});

test('find missing or invalid scalar metadata is explicit and never returns native proxies', () => {
  const s = shape(1, { SizeWidth: NaN, LeftX: Infinity, Type: undefined });
  Object.defineProperty(s, 'Name', { get() { throw new Error('unsupported'); } });
  const result = run('find_objects', {}, fixture([s]));
  assert.equal(result.objects[0].width, null);
  assert.equal(result.objects[0].x, null);
  assert.equal(result.objects[0].name, null);
  assert.equal(result.objects[0].type, null);
  assert.equal(result.incomplete, true);
});

test('curve inspection paginates nodes and subpaths with explicit truncation and no edit', () => {
  const result = run('inspect_curve', { id: 2, offset: 1, limit: 1, maxSubpaths: 1 }, fixture([curve(2, false)]));
  assert.equal(result.shapeId, 2);
  assert.equal(result.total, 2);
  assert.deepEqual(result.nodes, [{ index: 2, x: 3, y: 4, type: 1, ending: false }]);
  assert.deepEqual(result.subpaths, [{ index: 1, closed: false }]);
  assert.equal(result.subpathsTruncated, true);
  assert.equal(result.truncated, true);
});

test('curve inspection rejects missing IDs/noncurves/unsupported native collections cleanly', () => {
  assert.throws(() => run('inspect_curve', { id: 99 }, fixture([shape(1)])), /not found/);
  assert.throws(() => run('inspect_curve', { id: 1 }, fixture([shape(1)])), /curve/i);
  assert.throws(() => run('inspect_curve', { id: 1 }, fixture([shape(1, { Type: 3 })])), /unavailable|unsupported/i);
  const s = curve(1); s.Curve.Nodes.Count = Infinity;
  assert.throws(() => run('inspect_curve', { id: 1 }, fixture([s])), /unavailable|unsupported/i);
});

test('curve inspection marks unsupported node or closure measurements unknown', () => {
  const s = curve(1); s.Curve.Nodes.Item(1).PositionX = NaN; s.Curve.SubPaths.Item(1).Closed = undefined;
  const result = run('inspect_curve', { id: 1 }, fixture([s]));
  assert.equal(result.nodes[0].x, null);
  assert.equal(result.subpaths[0].closed, null);
  assert.equal(result.incomplete, true);
});

test('preflight detects dimensions/open curves and reports bitmap DPI estimates in nested groups', () => {
  const bitmap = shape(3, { Type: 5, RotationAngle: 0, Bitmap: { SizeWidth: 600, SizeHeight: 150, ResolutionX: 1200, ResolutionY: 1200 } });
  const group = shape(1, { Type: 7, Shapes: collection([curve(2, false), bitmap]) });
  const result = run('production_preflight', { expectedWidth: 25.4, expectedHeight: 25.4 }, fixture([group]));
  assert.equal(result.passed, false);
  assert.equal(result.checks.dimensions.status, 'pass');
  assert.equal(result.checks.openCurves.status, 'fail');
  assert.equal(result.checks.bitmapDpi.status, 'unknown');
  const item = result.items.find(item => item.shapeId === 3);
  assert.equal(item.checks.bitmapDpi.estimatedDpiX, 600);
  assert.equal(item.checks.bitmapDpi.estimatedDpiY, 150);
  assert.ok(result.notChecked.includes('fonts'));
  assert.ok(result.notChecked.includes('duplicateGeometry'));
});

test('preflight passes only checked complete scope and returns honest inapplicable checks', () => {
  const result = run('production_preflight', {}, fixture([curve(1)]));
  assert.equal(result.passed, true);
  assert.equal(result.checks.openCurves.status, 'pass');
  assert.equal(result.items[0].checks.dimensions.applicable, false);
  assert.equal(result.items[0].checks.bitmapDpi.applicable, false);
  assert.equal(result.scope, 'active-page objects and nested groups');
});

test('preflight unknowns prevent a pass for missing/nonfinite metadata, APIs and unsupported units', () => {
  for (const [s, args, unit, key] of [
    [shape(1, { SizeWidth: NaN }), { expectedWidth: 10 }, 3, 'dimensions'],
    [shape(1, { Type: undefined }), {}, 3, 'openCurves'],
    [shape(1, { Type: 3 }), {}, 3, 'openCurves'],
    [shape(1, { Type: 5, RotationAngle: 0, Bitmap: { SizeWidth: 600, SizeHeight: 600 } }), {}, 999, 'bitmapDpi'],
    [shape(1, { Type: 5, RotationAngle: 45, Bitmap: { SizeWidth: 600, SizeHeight: 600 } }), {}, 3, 'bitmapDpi'],
    [shape(1, { Type: 5, RotationAngle: 0, Bitmap: { ResolutionX: 600, ResolutionY: 600 } }), {}, 3, 'bitmapDpi']
  ]) {
    const result = run('production_preflight', args, fixture([s], unit));
    assert.equal(result.passed, false);
    assert.equal(result.checks[key].status, 'unknown');
  }
});

test('preflight never passes an incomplete scan even when all returned items pass', () => {
  const result = run('production_preflight', { maxShapes: 1 }, fixture([shape(1), shape(2)]));
  assert.equal(result.passed, false);
  assert.equal(result.incomplete, true);
  assert.equal(result.truncated, true);
  assert.equal(result.checks.openCurves.status, 'unknown');
  const malformed = shape(1, { Type: 7, Shapes: { Count: Infinity } });
  assert.equal(run('production_preflight', {}, fixture([malformed])).passed, false);
});

test('preflight resolves explicit IDs before scanning and checks summaries beyond output pagination', () => {
  const state = fixture([shape(1), curve(2, false)]);
  assert.throws(() => run('production_preflight', { ids: [1, 99] }, state), /not found/);
  const result = run('production_preflight', { limit: 1 }, state);
  assert.equal(result.items.length, 1);
  assert.equal(result.reportsTruncated, true);
  assert.equal(result.incomplete, false);
  assert.equal(result.checks.openCurves.status, 'fail');
  assert.equal(result.passed, false);
});

test('preflight rejects unverified unit codes and malformed native unit or type enums', () => {
  const bitmap = shape(1, { Type: 5, RotationAngle: 0, Bitmap: { SizeWidth: 600, SizeHeight: 600 } });
  for (const unit of [0, 2, 15, 16, '3', Infinity, null]) {
    const result = run('production_preflight', {}, fixture([bitmap], unit));
    assert.equal(result.checks.bitmapDpi.status, 'unknown');
    assert.equal(result.passed, false);
  }
  for (const type of [999, 3.5]) {
    const result = run('production_preflight', {}, fixture([shape(1, { Type: type })]));
    assert.equal(result.checks.openCurves.status, 'unknown');
    assert.equal(result.checks.bitmapDpi.status, 'unknown');
    assert.equal(result.passed, false);
  }
});

test('preflight known physical units compute bitmap DPI estimates without claiming transform integrity', () => {
  for (const [unit, size] of [[1, 1], [3, 25.4], [4, 2.54], [14, 72]]) {
    const state = fixture([shape(1, { Type: 5, SizeWidth: size, SizeHeight: size, RotationAngle: 180, Bitmap: { SizeWidth: 600, SizeHeight: 600 } })], unit);
    const result = run('production_preflight', {}, state);
    assert.equal(result.passed, false);
    assert.equal(result.checks.bitmapDpi.status, 'unknown');
    assert.ok(Math.abs(result.items[0].checks.bitmapDpi.estimatedDpiX - 600) < 1e-10);
    assert.equal(state.doc.Unit, unit);
  }
});

const byteLength = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const reportBudget = 128 * 1024;

test('find bounds actual UTF8 JSON bytes for Unicode and escaped scalar metadata', () => {
  for (const text of ['界'.repeat(500), '\0'.repeat(500), '\ud800'.repeat(500)]) {
    const shapes = Array.from({ length: 500 }, (_, index) => shape(index + 1, { Type: 6, Name: text, Text: { Story: { Text: text } } }));
    const result = run('find_objects', { limit: 500 }, fixture(shapes));
    assert.ok(result.objects.length > 0 && result.objects.length < 500);
    assert.ok(byteLength(result.objects) <= reportBudget);
    assert.ok(byteLength(result) < 256 * 1024);
    assert.equal(result.truncated, true);
    assert.equal(result.incomplete, true);
    const next = run('find_objects', {}, fixture([shapes[result.objects.length]])).objects[0];
    assert.ok(byteLength([...result.objects, next]) > reportBudget, 'fills array up to the next whole record boundary');
  }
});

test('preflight UTF8 report budget preserves complete summary for objects beyond returned records', () => {
  for (const text of ['界'.repeat(500), '\0'.repeat(500), '\ud800'.repeat(500)]) {
    const shapes = Array.from({ length: 500 }, (_, index) => shape(index + 1, { Name: text }));
    shapes.push(curve(501, false));
    const result = run('production_preflight', { limit: 500 }, fixture(shapes));
    assert.ok(result.items.length > 0 && result.items.length < 500);
    assert.ok(byteLength(result.items) <= reportBudget);
    assert.ok(byteLength(result) < 256 * 1024);
    assert.equal(result.total, 501);
    assert.equal(result.scanned, 501);
    assert.equal(result.reportsTruncated, true);
    assert.equal(result.incomplete, false);
    assert.equal(result.truncated, false);
    assert.equal(result.checks.openCurves.status, 'fail');
    assert.equal(result.passed, false);
    const next = run('production_preflight', {}, fixture([shapes[result.items.length]])).items[0];
    assert.ok(byteLength([...result.items, next]) > reportBudget);
  }
});

test('curve node and subpath arrays share a UTF8 budget and preserve explicit null native scalars', () => {
  for (const text of ['界'.repeat(500), '\0'.repeat(500), '\ud800'.repeat(500)]) {
    const s = curve(1);
    s.Curve.Nodes = collection(Array.from({ length: 1000 }, () => ({ PositionX: null, PositionY: null, Type: text, IsEnding: null })));
    s.Curve.SubPaths = collection(Array.from({ length: 500 }, () => ({ Closed: null })));
    const result = run('inspect_curve', { id: 1, limit: 1000, maxSubpaths: 500 }, fixture([s]));
    assert.ok(result.nodes.length > 0 && result.nodes.length < 1000);
    assert.ok(byteLength(result.nodes) + byteLength(result.subpaths) <= reportBudget);
    assert.ok(byteLength(result) < 256 * 1024);
    assert.equal(result.truncated, true);
    assert.equal(result.reportsTruncated, true);
    assert.equal(result.incomplete, true);
    assert.equal(result.nodes[0].x, null);
    assert.equal(result.nodes[0].y, null);
    assert.equal(result.nodes[0].ending, null);
    if (result.subpaths.length) assert.equal(result.subpaths[0].closed, null);
  }
  const s = curve(1);
  s.Curve.Nodes = collection([{ PositionX: null, PositionY: null, Type: null, IsEnding: null }]);
  const result = run('inspect_curve', { id: 1 }, fixture([s]));
  assert.deepEqual(result.nodes, [{ index: 1, x: null, y: null, type: null, ending: null }]);
  assert.equal(result.incomplete, true);
});


test('preflight cannot pass a zero-rotation sheared bitmap from axis bounds alone', () => {
  // A transformed unit square can have axis vectors (1,0) and (sqrt(3),1).
  // Its one-inch high bbox hides a two-inch long bitmap Y axis: 350/2=175 DPI.
  const s = shape(1, { Type: 5, RotationAngle: 0, SizeWidth: 1 + Math.sqrt(3), SizeHeight: 1, Bitmap: { SizeWidth: 1000, SizeHeight: 350 } });
  const result = run('production_preflight', {}, fixture([s], 1));
  const check = result.items[0].checks.bitmapDpi;
  assert.equal(check.status, 'unknown');
  assert.equal(result.passed, false);
  assert.match(check.reason, /shear or ancestor transforms/);
  assert.ok(Math.abs(check.estimatedDpiX - 366.02540378443865) < 1e-10);
  assert.equal(check.estimatedDpiY, 350);
  assert.equal(check.dpiX, undefined);
  assert.equal(check.dpiY, undefined);
});
