import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { editorTools, buildEditorOperation } from '../src/editor.mjs';
import { documentScript } from '../src/document.mjs';
import { buildOperation } from '../src/tools.mjs';

const collection = values => ({ Count: values.length, Item: i => values[i - 1] });
const describe = s => ({ shapeId: s.StaticID, name: s.Name, x: s.LeftX, y: s.BottomY, width: s.SizeWidth, height: s.SizeHeight });
function shape(id, x = 0, y = 0, width = 10, height = 10) {
  return { StaticID: id, Name: `shape-${id}`, Type: 1, LeftX: x, BottomY: y, SizeWidth: width, SizeHeight: height,
    Move(dx, dy) { this.LeftX += dx; this.BottomY += dy; },
    OrderToFront() { this.order = 'front'; }, OrderToBack() { this.order = 'back'; } };
}
function context(shapes = []) {
  const state = { shapes, selected: [], curve: null, created: [] };
  const range = values => ({ ...collection(values),
    CreateSelection() { state.selected = values.map(s => s.StaticID); },
    Move(dx, dy) { values.forEach(s => s.Move(dx, dy)); },
    Group() { state.grouped = values.map(s => s.StaticID); return shape(100); },
    SetSize(w, h) { state.resized = [w, h]; }, Rotate(angle) { state.rotation = angle; },
    get LeftX() { return Math.min(...values.map(s => s.LeftX)); },
    get BottomY() { return Math.min(...values.map(s => s.BottomY)); },
    get SizeWidth() { return Math.max(...values.map(s => s.LeftX + s.SizeWidth)) - this.LeftX; },
    get SizeHeight() { return Math.max(...values.map(s => s.BottomY + s.SizeHeight)) - this.BottomY; }
  });
  const page = { Shapes: collection(shapes), Layers: collection([]), CreateLayer(name) { const l = { Name: name, Shapes: collection([]), Activate() { state.activeLayer = name; } }; state.created.push(l); return l; } };
  const layer = { CreateCurve(curve) { state.curve = curve; const s = shape(200); state.created.push(s); return s; } };
  const host = { CreateCurve() { return { paths: [], CreateSubPath(x, y) { const p = { start: [x, y], segments: [], AppendLineSegment(...v) { this.segments.push(['line', ...v]); }, AppendCurveSegment2(...v) { this.segments.push(['cubic', ...v]); } }; this.paths.push(p); return p; } }; } };
  return { state, host, doc: {}, page, layer, describeShape: describe, describeDocument: () => ({ id: 'name:test' }),
    getShapeName: s => String(s.Name || ''), setShapeName(s, name) { s.Name = name; if (String(s.Name) !== name) throw new Error('Unable to set verified shape name'); },
    color: hex => hex, getShape(id) { const s = shapes.find(s => s.StaticID === id); if (!s) throw new Error(`Shape ${id} not found`); return s; },
    getShapes(ids) { return range(ids.map(id => this.getShape(id))); } };
}
function run(name, args, ctx = context()) {
  const op = buildEditorOperation(`coreldraw_${name}`, args);
  assert.ok(op, `${name} must compile`);
  const environment = { ...ctx, args };
  environment.getShapes = ids => {
    const saved = ctx.getShapes;
    return saved.call(ctx, ids);
  };
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(function(){${op.body}\n})()`, environment)));
}

test('catalog exposes bounded editing schemas and unknown names remain unhandled', () => {
  assert.equal(buildEditorOperation('other_tool', {}), null);
  const t = editorTools.find(t => t.name === 'coreldraw_select_objects');
  assert.equal(t.inputSchema.properties.ids.maxItems, 1000);
  assert.equal(t.inputSchema.additionalProperties, false);
  assert.equal(editorTools.find(t => t.name === 'coreldraw_list_objects').annotations.readOnlyHint, true);
});

test('combined builder rejects malformed curves, fractional IDs and color values before execution', async () => {
  await assert.rejects(buildOperation('coreldraw_create_path', { subpaths: [{ start: { x: 0, y: 0 }, segments: [{ type: 'cubic', x: 1, y: 1 }] }] }), /c1|match|schema|alternative/i);
  await assert.rejects(buildOperation('coreldraw_select_objects', { ids: [1.2] }), /integer/i);
  await assert.rejects(buildOperation('coreldraw_style_objects', { ids: [1], fill: '#fff' }), /match|pattern|alternative/i);
});

test('object inventory recurses groups, preserves parent IDs and truncates explicitly', () => {
  const group = shape(1); group.Type = 7; group.Shapes = collection([shape(2), shape(3)]);
  const ctx = context([group, shape(4)]);
  const result = run('list_objects', { recursive: true, limit: 2 }, ctx);
  assert.deepEqual(result.objects.map(s => s.shapeId), [1, 2]);
  assert.equal(result.objects[1].parentId, 1);
  assert.equal(result.truncated, true);
});

test('layer listing and creation return bounded scalar data and activate only on request', () => {
  const ctx = context(); ctx.page.Layers = collection([{ Name: 'Artwork', Visible: true, Editable: true, Printable: false, Shapes: collection([]) }]);
  assert.equal(run('list_layers', {}, ctx).layers[0].name, 'Artwork');
  assert.equal(run('create_layer', { name: 'Cut lines', activate: true }, ctx).name, 'Cut lines');
  assert.equal(ctx.state.activeLayer, 'Cut lines');
});

test('selection resolves every ID before changing selection', () => {
  const ctx = context([shape(1), shape(2)]);
  assert.throws(() => run('select_objects', { ids: [1, 99] }, ctx), /not found/);
  assert.deepEqual(ctx.state.selected, []);
  run('select_objects', { ids: [2, 1] }, ctx);
  assert.deepEqual(ctx.state.selected, [2, 1]);
});

test('path compilation preserves endpoint/control point ordering and closed subpaths', () => {
  const ctx = context();
  const result = run('create_path', { name: 'river', subpaths: [{ start: { x: 1, y: 2 }, segments: [{ type: 'line', x: 3, y: 4 }, { type: 'cubic', x: 9, y: 10, c1: { x: 5, y: 6 }, c2: { x: 7, y: 8 } }], closed: true }] }, ctx);
  assert.equal(result.name, 'river');
  assert.deepEqual(ctx.state.curve.paths[0].segments, [['line', 3, 4, false], ['cubic', 9, 10, 5, 6, 7, 8, false]]);
  assert.equal(ctx.state.curve.paths[0].Closed, true);
});

test('invalid cubic input fails before any shape is created', () => {
  const ctx = context();
  assert.throws(() => run('create_path', { subpaths: [{ start: { x: 0, y: 0 }, segments: [{ type: 'cubic', x: 1, y: 1 }] }] }, ctx), /control|c1/i);
  assert.equal(ctx.state.created.length, 0);
});

test('polygon creates one closed native curve from given points', () => {
  const ctx = context();
  run('create_polygon', { points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 2, y: 4 }] }, ctx);
  assert.deepEqual(ctx.state.curve.paths[0].start, [0, 0]);
  assert.equal(ctx.state.curve.paths[0].Closed, true);
  assert.equal(ctx.state.created.length, 1);
});

test('requested path and polygon names fail when the host silently ignores naming', () => {
  for (const [tool, geometry] of [
    ['create_path', { subpaths: [{ start: { x: 0, y: 0 }, segments: [{ type: 'line', x: 1, y: 1 }] }] }],
    ['create_polygon', { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }]
  ]) {
    const ctx = context(), created = shape(200);
    Object.defineProperty(created, 'Name', { get: () => 'old name', set() {} });
    ctx.layer.CreateCurve = () => created;
    assert.throws(() => run(tool, { ...geometry, name: 'requested name' }, ctx), /verified shape name/);
  }
});

test('style applies native colors, linear gradient type, outline and transparency', () => {
  const s = shape(1), applied = {};
  s.Fill = { ApplyUniformFill(v) { applied.fill = v; }, ApplyFountainFill(...v) { applied.gradient = v; } };
  s.Outline = { SetProperties(...v) { applied.outline = v; } };
  s.Transparency = { ApplyUniformTransparency(v) { applied.transparency = v; } };
  const ctx = context([s]);
  run('style_objects', { ids: [1], fill: '#abcdef', outline: { color: '#112233', width: 0.2 }, transparency: 30 }, ctx);
  assert.deepEqual(applied, { fill: '#abcdef', outline: [0.2, undefined, '#112233'], transparency: 30 });
  run('style_objects', { ids: [1], fill: { start: '#112233', end: '#445566', angle: 90 } }, ctx);
  assert.deepEqual(applied.gradient, ['#112233', '#445566', 1, 90]);
});

test('style preflights missing style interfaces before first mutation', () => {
  let changed = false;
  const a = shape(1), b = shape(2); a.Fill = { ApplyUniformFill() { changed = true; } }; b.Fill = null;
  assert.throws(() => run('style_objects', { ids: [1, 2], fill: '#123456' }, context([a, b])), /unsupported/i);
  assert.equal(changed, false);
});

test('unavailable native APIs produce an explicit editor operation failure', () => {
  const a = shape(1); a.Fill = {};
  assert.throws(() => run('style_objects', { ids: [1], fill: '#123456' }, context([a])), /CorelDRAW.*API.*ApplyUniformFill|CorelDRAW.*API.*not a function/i);
});

test('editor bodies integrate with document targeting and close undo groups after failure', () => {
  const a = shape(1, 5, 6), ctx = context([a]), groups = [];
  const doc = { Name: 'target', FullFileName: '', ActivePage: ctx.page, ActiveLayer: ctx.layer,
    Activate() { host.ActiveDocument = this; }, BeginCommandGroup(label) { groups.push(['begin', label]); }, EndCommandGroup() { groups.push(['end']); } };
  const host = { Documents: collection([doc]), ActiveDocument: doc, CreateShapeRange() { const values = []; return { Add(s) { values.push(s); }, get Count() { return values.length; }, Item(i) { return values[i-1]; }, Move(dx,dy) { values.forEach(s => s.Move(dx,dy)); }, get LeftX() { return a.LeftX; }, get BottomY() { return a.BottomY; } }; } };
  const args = { document: 'name:target', ids: [1], x: 0, y: 0 };
  const operation = buildEditorOperation('coreldraw_transform_objects', args);
  const result = vm.runInNewContext(`(function(){${documentScript(args, operation.body, operation)}\n})()`, { host });
  assert.equal(result.objects[0].x, 0); assert.equal(a.BottomY, 0);
  assert.deepEqual(groups.map(g => g[0]), ['begin', 'end']);
  const broken = buildEditorOperation('coreldraw_style_objects', { ids: [1], fill: '#123456' });
  assert.throws(() => vm.runInNewContext(`(function(){${documentScript({ document: 'name:target', ids: [1], fill: '#123456' }, broken.body, broken)}\n})()`, { host }), /partial.*Undo/i);
  assert.deepEqual(groups.map(g => g[0]), ['begin', 'end', 'begin', 'end']);
});

test('text formatting rejects non-text objects before changing existing text', () => {
  const a = shape(1), b = shape(2); a.Type = 6; a.Text = { Story: { Font: 'Arial', Size: 10 } };
  const ctx = context([a, b]);
  assert.throws(() => run('style_text', { ids: [1, 2], font: 'Helvetica' }, ctx), /text/i);
  assert.equal(a.Text.Story.Font, 'Arial');
  run('style_text', { ids: [1], font: 'Helvetica', size: 22, bold: true, italic: false, align: 'center' }, ctx);
  assert.deepEqual(a.Text.Story, { Font: 'Helvetica', Size: 22, Bold: true, Italic: false, Alignment: 3 });
});

test('transform positions collective lower-left and applies relative rotation', () => {
  const ctx = context([shape(1, 5, 6), shape(2, 20, 30)]);
  run('transform_objects', { ids: [1, 2], x: -5, y: 0, rotation: 15 }, ctx);
  assert.equal(ctx.state.shapes[0].LeftX, -5); assert.equal(ctx.state.shapes[0].BottomY, 0);
  assert.equal(ctx.state.shapes[1].LeftX, 10); assert.equal(ctx.state.rotation, 15);
});

test('alignment uses union edges and equal-gap distribution keeps exterior edges fixed', () => {
  const ctx = context([shape(1, 0, 0, 10, 4), shape(2, 13, 8, 20, 5), shape(3, 50, 2, 10, 6)]);
  run('arrange_objects', { ids: [1, 2, 3], mode: 'top' }, ctx);
  assert.deepEqual(ctx.state.shapes.map(s => s.BottomY + s.SizeHeight), [13, 13, 13]);
  run('arrange_objects', { ids: [3, 1, 2], mode: 'distribute_x' }, ctx);
  assert.deepEqual(ctx.state.shapes.map(s => s.LeftX), [0, 20, 50]);
});

test('distribution rejects contained exterior bounds before moving any object', () => {
  const ctx = context([shape(1, 0, 0, 1, 1), shape(2, 10, 0, 100, 1), shape(3, 20, 0, 1, 1)]);
  assert.throws(() => run('arrange_objects', { ids: [1, 2, 3], mode: 'distribute_x' }, ctx), /outer.*bound|exterior|contain/i);
  assert.deepEqual(ctx.state.shapes.map(s => s.LeftX), [0, 10, 20]);
});

test('group and ungroup return explicit resulting IDs', () => {
  const a = shape(1), b = shape(2); a.Type = 7; a.Shapes = collection([b]); a.UngroupEx = () => collection([b]);
  const ctx = context([a, b]);
  assert.equal(run('group_objects', { ids: [1, 2], action: 'group' }, ctx).shapeId, 100);
  assert.deepEqual(run('group_objects', { ids: [1], action: 'ungroup' }, ctx).objects.map(s => s.shapeId), [2]);
});

test('ungroup preflights output bound before changing any group', () => {
  const a = shape(1); a.Type = 7; a.Shapes = { Count: 1001 };
  let changed = false; a.UngroupEx = () => { changed = true; return collection([]); };
  assert.throws(() => run('group_objects', { ids: [1], action: 'ungroup' }, context([a])), /1000/);
  assert.equal(changed, false);
});

test('empty outline records fail rather than claiming a style edit', () => {
  const a = shape(1); let changed = false; a.Outline = { SetProperties() { changed = true; } };
  assert.throws(() => run('style_objects', { ids: [1], outline: {} }, context([a])), /outline.*property|outline.*color.*width/i);
  assert.equal(changed, false);
});

test('ordering moves all resolved objects and boolean calls preserve source/target intent', () => {
  const a = shape(1), b = shape(2); let called;
  a.Trim = (target, leaveSource, leaveTarget) => { called = [target.StaticID, leaveSource, leaveTarget]; return shape(9); };
  const ctx = context([a, b]);
  run('order_objects', { ids: [1, 2], position: 'back' }, ctx);
  assert.deepEqual([a.order, b.order], ['back', 'back']);
  assert.equal(run('combine_shapes', { ids: [1, 2], operation: 'trim', keepOriginals: true }, ctx).shapeId, 9);
  assert.deepEqual(called, [2, true, true]);
});

test('front and back ordering preserve relative stacking when native ZOrder one is front', () => {
  const a = shape(1), b = shape(2), c = shape(3), d = shape(4);
  let stack = [c, a, d, b];
  for (const s of stack) {
    Object.defineProperty(s, 'ZOrder', { get: () => stack.indexOf(s) + 1 });
    s.OrderToFront = () => { stack = [s, ...stack.filter(item => item !== s)]; };
    s.OrderToBack = () => { stack = [...stack.filter(item => item !== s), s]; };
  }
  const ctx = context([a, b, c, d]);
  run('order_objects', { ids: [b.StaticID, a.StaticID], position: 'front' }, ctx);
  assert.deepEqual(stack.map(s => s.StaticID), [1, 2, 3, 4]);
  run('order_objects', { ids: [a.StaticID, b.StaticID], position: 'back' }, ctx);
  assert.deepEqual(stack.map(s => s.StaticID), [3, 4, 1, 2]);
});

test('contour sends direction enum, offset and bounded step count and rejects missing effect', () => {
  const a = shape(1); let called; a.Outline = { Color: '#112233' }; a.Fill = { Type: 1, UniformColor: '#445566' };
  a.CreateContour = (...args) => { called = args; return { Type: 2 }; };
  run('contour', { ids: [1], direction: 'outside', offset: 2, steps: 3 }, context([a]));
  assert.deepEqual(called, [1, 2, 3, 0, '#112233', '#445566', '#445566', 0, 0, 0, 0, 0]);
  a.CreateContour = () => null;
  assert.throws(() => run('contour', { ids: [1], direction: 'inside', offset: 2 }, context([a])), /contour.*result|effect/i);
});

test('contour provides real colors for native full signature and exposes explicit overrides', async () => {
  const a = shape(1); a.Outline = { Color: '#123456' }; a.Fill = { Type: 2 }; let called;
  a.CreateContour = (...args) => { called = args; return { Type: 6 }; };
  const ctx = context([a]);
  run('contour', { ids: [1], direction: 'inside', offset: 0.5 }, ctx);
  assert.deepEqual(called.slice(4, 7), ['#123456', '#FFFFFF', '#FFFFFF']);
  const args = { ids: [1], direction: 'center', offset: 1, outlineColor: '#112233', fillColor: '#445566', endFillColor: '#778899' };
  await buildOperation('coreldraw_contour', args);
  run('contour', args, ctx);
  assert.deepEqual(called, [2, 1, 1, 0, '#112233', '#445566', '#778899', 0, 0, 0, 0, 0]);
});
