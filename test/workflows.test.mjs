import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { workflowTools, buildWorkflowOperation } from '../src/workflows.mjs';

function fixture(extra = {}) {
  const all = [], calls = [];
  function shape(type, name = '') {
    const s = { StaticID: all.length + 1, Type: type, Name: name, Outline: { Width: 0, Color: { CopyAssign(c) { calls.push(['outline', c]); } } },
      Fill: { ApplyUniformFill(c) { calls.push(['fill', c]); }, UniformColor: { CopyAssign(c) { calls.push(['fill', c]); } }, ApplyNoFill() { calls.push(['noFill', s.StaticID]); } } };
    if (type === 6) s.Text = { Story: { Text: '' } };
    all.push(s); return s;
  }
  const layer = {
    CreateRectangle2(...v) { calls.push(['rect', ...v]); return shape(1); },
    CreateEllipse(...v) { calls.push(['ellipse', ...v]); return shape(2); },
    CreateArtisticText(...v) { calls.push(['text', ...v]); const s = shape(6); s.Text.Story.Text = v[2]; return s; },
    CreateCurve(curve) { calls.push(['curve', curve]); return shape(3); },
  };
  const doc = { Unit: 3 };
  const host = { CreateCurve() { const c = { points: [], CreateSubPath(x, y) { this.points.push([x,y]); const sub = { Closed: false, AppendLineSegment(x,y) { c.points.push([x,y]); } }; this.subpath = sub; return sub; } }; return c; } };
  const ctx = { args: {}, host, doc, layer, page: {}, color: h => h, getShape(id) { const s = all.find(s => s.StaticID === id); if (!s) throw new Error('Unknown shape '+id); return s; },
    getShapes(ids) { return { Count: ids.length, Item(i) { return ctx.getShape(ids[i-1]); }, Group() { const g = shape(7); g.Shapes = { Count: ids.length, Item(i) { return ctx.getShape(ids[i-1]); } }; return g; } }; },
    getShapeName(s) { return s.Name; }, setShapeName(s,name) {s.Name=name;if(s.Name!==name)throw new Error('Cannot persist shape name');},
    describeShape(s) { return { shapeId: s.StaticID, name: s.Name, type: s.Type }; }, describeDocument(d) { return { unit: d.Unit }; }, ...extra };
  function run(name, args) { ctx.args = args; const op = buildWorkflowOperation(name, args); return vm.runInNewContext('(function(){'+op.body+'})()', ctx); }
  return { all, calls, ctx, shape, run };
}

test('workflow catalog uses bounded structured inputs and mutating annotations', () => {
  assert.equal(workflowTools.length, 6);
  for (const t of workflowTools) { assert.equal(t.inputSchema.additionalProperties, false); assert.equal(t.annotations.readOnlyHint, false); assert.equal(typeof t.description, 'string'); }
  assert.equal(buildWorkflowOperation('unknown', {}), null);
  const units = workflowTools.find(t => t.name === 'coreldraw_set_units');
  assert.deepEqual(units.inputSchema.properties.unit.enum, ['mm','cm','inches','points','pixels']);
  const batch = workflowTools.find(t => t.name === 'coreldraw_personalize_batch');
  assert.equal(batch.inputSchema.properties.records.maxItems, 100);
});

test('unit values match documented cdrUnit enum', () => {
  const f = fixture();
  for (const [unit, value] of Object.entries({ mm:3, cm:4, inches:1, points:14, pixels:5 })) { const r = f.run('coreldraw_set_units', {unit}); assert.equal(f.ctx.doc.Unit, value); assert.equal(r.unit, unit); }
  assert.throws(() => f.run('coreldraw_set_units', {unit:'yards'}), /unit/i);
});

test('dimension creates non-associative extension lines, measurement line and label', () => {
  const f = fixture();
  const r = f.run('coreldraw_add_dimension', { x1:0,y1:0,x2:3,y2:4,offset:10,precision:1,unitSuffix:'mm' });
  assert.equal(r.measurement, 5); assert.equal(r.label, '5.0 mm'); assert.equal(r.associative, false);
  assert.equal(f.calls.filter(v => v[0] === 'curve').length, 3);
  assert.equal(f.calls.find(v => v[0] === 'text')[3], '5.0 mm');
  assert.equal(r.shapes.length, 4);
});

test('dimension preflights zero length before mutation and supports literal label', () => {
  const f = fixture();
  assert.throws(() => f.run('coreldraw_add_dimension', {x1:1,y1:1,x2:1,y2:1,offset:2}), /distinct/);
  assert.equal(f.all.length, 0);
  const r = f.run('coreldraw_add_dimension', {x1:0,y1:0,x2:2,y2:0,offset:-1,label:'Cut here'});
  assert.equal(r.label, 'Cut here');
});

test('cut line preflights all IDs and assigns width and outline color', () => {
  const f = fixture(); const s = f.shape(1);
  assert.throws(() => f.run('coreldraw_set_cut_line', {shapeIds:[s.StaticID,999],width:0.1,color:'#FF00FF'}), /Unknown/);
  assert.equal(f.calls.length, 0);
  f.run('coreldraw_set_cut_line', {shapeIds:[s.StaticID],width:0.1,color:'#FF00FF'});
  assert.equal(s.Outline.Width, 0.1); assert.deepEqual(f.calls[0], ['outline','#FF00FF']); assert.equal(f.calls[1][0], 'noFill');
});

test('custom scene creates editable primitives, closed polygon and names', () => {
  const f = fixture();
  const r = f.run('coreldraw_create_scene', {name:'Reusable',x:10,y:20,group:false,scene:{elements:[
    {type:'rect',name:'Border',x:0,y:0,width:10,height:8,fill:'#123456'},
    {type:'ellipse',x:1,y:2,width:3,height:4},
    {type:'polygon',points:[{x:0,y:0},{x:3,y:0},{x:0,y:3}]},
    {type:'text',name:'Title',x:2,y:3,text:'Hello',fontSize:14},
  ]}});
  assert.equal(r.shapes.length, 4); assert.equal(f.all[0].Name, 'Border');
  assert.deepEqual(f.calls.find(v=>v[0]==='rect'), ['rect',10,20,10,8]);
  assert.equal(f.calls.find(v=>v[0]==='curve')[1].subpath.Closed, true);
  assert.equal(f.all[3].Text.Story.Size, 14);
});

test('built-in landscape and sign scenes are finite editable groups', () => {
  for (const template of ['landscape','sign']) { const f = fixture(); const r = f.run('coreldraw_create_scene',{template,width:200,height:100,title:'Workshop'}); assert.ok(r.shapes.length >= 3); assert.equal(r.group.type,7); assert.ok(f.all.some(s=>s.Name)); }
});

function groupFixture() {
  const f = fixture(); const title = f.shape(6,'Title'); const other = f.shape(1,'Frame'); const g = f.shape(7,'Original');
  g.Shapes = {Count:2,Item(i) { return [title,other][i-1]; }};
  g.Duplicate = (x,y) => { f.calls.push(['duplicate',x,y]); const t = f.shape(6,'Title'); t.Text.Story.Text = title.Text.Story.Text; const clone = f.shape(7); clone.Shapes = {Count:1,Item() {return t;}}; return clone; };
  return {...f,g,title};
}

test('personalization rejects unknown and non-text names before any duplicate', () => {
  const f = groupFixture();
  for (const name of ['Missing','Frame']) assert.throws(() => f.run('coreldraw_personalize_batch',{sourceId:f.g.StaticID,records:[{replacements:[{name:'Title',text:'First'}]},{replacements:[{name,text:'Bad'}]}],offsetX:20,offsetY:0}), /Missing|Frame/);
  assert.equal(f.calls.length,0); assert.equal(f.title.Text.Story.Text,'');
});

test('personalization duplicates with offsets and replaces named text without changing source', () => {
  const f = groupFixture(); const r = f.run('coreldraw_personalize_batch',{sourceId:f.g.StaticID,records:[{name:'One',replacements:[{name:'Title',text:'Alice'}]},{name:'Two',replacements:[{name:'Title',text:'Bob'}]}],offsetX:20,offsetY:5});
  assert.equal(r.status,'complete'); assert.equal(r.completed.length,2); assert.equal(f.title.Text.Story.Text,'');
  assert.deepEqual(f.calls.filter(v=>v[0]==='duplicate'),[['duplicate',20,5],['duplicate',40,10]]);
  assert.deepEqual(f.all.filter(s=>s.Type===6).map(s=>s.Text.Story.Text),['','Alice','Bob']);
});

test('scene batch preflights all scenes and reports partial failures with surviving IDs', () => {
  const f = fixture();
  assert.throws(() => f.run('coreldraw_scene_batch',{scenes:[{template:'sign'},{scene:{elements:[{type:'invalid'}]}}]}), /type/i);
  assert.equal(f.all.length,0);
  const original = f.ctx.layer.CreateRectangle2; let n=0;
  f.ctx.layer.CreateRectangle2 = (...a) => { if (++n===2) throw new Error('native failure'); return original(...a); };
  const r = f.run('coreldraw_scene_batch',{scenes:[{scene:{elements:[{type:'rect',x:0,y:0,width:5,height:5}]}},{scene:{elements:[{type:'text',x:0,y:0,text:'survives'},{type:'rect',x:0,y:0,width:5,height:5}]}},{template:'sign'}]});
  assert.equal(r.status,'partial'); assert.equal(r.completed.length,1); assert.equal(r.failed.index,1); assert.match(r.failed.error,/native failure/); assert.equal(r.failed.createdShapeIds.length,1); assert.equal(r.notAttempted,1);
});

test('personalization returns surviving copy evidence when text mutation fails', () => {
  const f = groupFixture(); let copy;
  f.g.Duplicate = () => { copy = f.shape(7); const child = f.shape(6,'Title'); Object.defineProperty(child.Text.Story,'Text',{set(){throw new Error('Text locked');}}); copy.Shapes={Count:1,Item(){return child;}}; return copy; };
  const r=f.run('coreldraw_personalize_batch',{sourceId:f.g.StaticID,records:[{replacements:[{name:'Title',text:'A'}]},{replacements:[{name:'Title',text:'B'}]}],offsetX:1,offsetY:0});
  assert.equal(r.partial,true); assert.equal(r.failedIndex,0); assert.equal(r.failed.createdShapeIds[0],copy.StaticID); assert.equal(r.notAttempted,1); assert.match(r.error,/Text locked/);
});

test('personalization bounds total copied descendants before any duplicate', () => {
  const f=groupFixture(); const children=Array.from({length:101},(_,i)=>f.shape(6,i===0?'Title':'Other '+i));
  f.g.Shapes={Count:children.length,Item(i){return children[i-1];}};
  assert.throws(()=>f.run('coreldraw_personalize_batch',{sourceId:f.g.StaticID,records:Array.from({length:100},()=>({replacements:[{name:'Title',text:'A'}]})),offsetX:1,offsetY:0}),/10000/);
  assert.equal(f.calls.length,0);
});

test('personalization supports prototype-like names as literal named text', () => {
  const f=groupFixture(); f.title.Name='__proto__';
  f.g.Duplicate=()=>{const t=f.shape(6,'__proto__'),g=f.shape(7);g.Shapes={Count:1,Item(){return t;}};return g;};
  const r=f.run('coreldraw_personalize_batch',{sourceId:f.g.StaticID,records:[{replacements:[{name:'__proto__',text:'safe'}]}],offsetX:1,offsetY:0});
  assert.equal(r.status,'complete'); assert.equal(f.all.filter(s=>s.Type===6).at(-1).Text.Story.Text,'safe');
});

test('scene naming uses shared logical label helpers when the native Name setter is ineffective', () => {
  const f=fixture();
  f.ctx.getShapeName=s=>s.logicalName || '';
  f.ctx.setShapeName=(s,name)=>{s.logicalName=name;};
  f.ctx.describeShape=s=>({shapeId:s.StaticID,name:f.ctx.getShapeName(s),type:s.Type});
  const r=f.run('coreldraw_create_scene',{template:'sign',name:'Logical sign'});
  assert.equal(r.group.name,'Logical sign'); assert.ok(r.shapes.some(s=>s.name==='Title'));
  assert.equal(f.all.find(s=>s.logicalName==='Title').Name,'');
});

test('failed logical naming reports the created scene object instead of success', () => {
  const f=fixture(); f.ctx.getShapeName=s=>s.Name;
  f.ctx.setShapeName=()=>{throw new Error('Cannot persist shape name');};
  const r=f.run('coreldraw_create_scene',{scene:{elements:[{type:'rect',name:'Border',x:0,y:0,width:5,height:5}]}});
  assert.equal(r.partial,true); assert.match(r.error,/persist/); assert.deepEqual(Array.from(r.failed.createdShapeIds),[1]); assert.equal(r.completed.length,0);
});

test('failed group naming retains group and child IDs in partial scene evidence', () => {
  const f=fixture(); f.ctx.getShapeName=s=>s.Name;
  f.ctx.setShapeName=(s,name)=>{if(s.Type===7)throw new Error('Group name failed');s.Name=name;};
  const r=f.run('coreldraw_create_scene',{name:'Grouped',scene:{elements:[{type:'text',x:0,y:0,text:'Content'}]}});
  assert.equal(r.partial,true); assert.deepEqual(Array.from(r.failed.createdShapeIds),[1,2]); assert.match(r.error,/Group name/);
});

test('personalization resolves logical names and names new copies through shared helpers', () => {
  const f=groupFixture(); f.title.logicalName='Title';
  f.ctx.getShapeName=s=>s.logicalName || '';
  f.ctx.setShapeName=(s,name)=>{s.logicalName=name;};
  f.ctx.describeShape=s=>({shapeId:s.StaticID,name:f.ctx.getShapeName(s),type:s.Type});
  f.g.Duplicate=()=>{const t=f.shape(6),g=f.shape(7); t.logicalName='Title';g.Shapes={Count:1,Item(){return t;}};return g;};
  const r=f.run('coreldraw_personalize_batch',{sourceId:f.g.StaticID,records:[{name:'Alice copy',replacements:[{name:'Title',text:'Alice'}]}],offsetX:1,offsetY:0});
  assert.equal(r.status,'complete'); assert.equal(r.completed[0].shape.name,'Alice copy'); assert.equal(f.all.filter(s=>s.Type===6).at(-1).Text.Story.Text,'Alice');
});

test('scene returns reusable explicit label and text field manifests without native names', () => {
  const f=fixture(); f.ctx.getShapeName=()=>''; f.ctx.setShapeName=()=>{};
  const r=f.run('coreldraw_create_scene',{template:'sign',name:'Sign'});
  assert.equal(r.groupId,r.group.shapeId); assert.equal(r.namedShapes.length,4);
  assert.deepEqual(Array.from(r.textFields,v=>v.name),['Title','Subtitle']);
  assert.ok(r.textFields.every(v=>r.namedShapes.some(n=>n.name===v.name && n.shapeId===v.shapeId)));
});

function anonymousGroupFixture() {
  const f=fixture(), title=f.shape(6),nested=f.shape(7),frame=f.shape(1),root=f.shape(7);
  nested.Shapes={Count:1,Item(){return title;}};root.Shapes={Count:2,Item(i){return [frame,nested][i-1];}};
  root.Duplicate=(x,y)=>{f.calls.push(['duplicate',x,y]);const t=f.shape(6),n=f.shape(7),b=f.shape(1),g=f.shape(7);n.Shapes={Count:1,Item(){return t;}};g.Shapes={Count:2,Item(i){return [b,n][i-1];}};return g;};
  f.ctx.getShapeName=()=>''; f.ctx.setShapeName=()=>{};
  return {...f,title,nested,frame,root};
}

test('explicit source field IDs personalize nested anonymous copies using tree index paths', () => {
  const f=anonymousGroupFixture();
  const fields=[{name:'Title',shapeId:f.title.StaticID}];
  const r=f.run('coreldraw_personalize_batch',{sourceId:f.root.StaticID,fields,records:[{replacements:[{name:'Title',text:'Alice'}]}],offsetX:20,offsetY:0});
  assert.equal(r.status,'complete');assert.equal(r.sourceId,f.root.StaticID);assert.deepEqual(Array.from(r.fields,v=>({name:v.name,shapeId:v.shapeId})),fields);
  assert.equal(f.all.filter(s=>s.Type===6).at(-1).Text.Story.Text,'Alice');assert.equal(f.title.Text.Story.Text,'');
  assert.equal(r.completed[0].groupId,r.completed[0].shape.shapeId);assert.equal(r.completed[0].textFields[0].name,'Title');
  assert.notEqual(r.completed[0].textFields[0].shapeId,f.title.StaticID);
});

test('explicit field preflight rejects outside, nontext, duplicate and unknown replacement maps', () => {
  for(const scenario of ['outside','nontext','duplicateName','duplicateId','unknown']) {
    const f=anonymousGroupFixture(), outsider=f.shape(6);
    let fields=[{name:'Title',shapeId:f.title.StaticID}];
    if(scenario==='outside')fields=[{name:'Title',shapeId:outsider.StaticID}];
    if(scenario==='nontext')fields=[{name:'Title',shapeId:f.frame.StaticID}];
    if(scenario==='duplicateName')fields.push({name:'Title',shapeId:outsider.StaticID});
    if(scenario==='duplicateId')fields.push({name:'Alias',shapeId:f.title.StaticID});
    assert.throws(()=>f.run('coreldraw_personalize_batch',{sourceId:f.root.StaticID,fields,records:[{replacements:[{name:scenario==='unknown'?'Missing':'Title',text:'A'}]}],offsetX:1,offsetY:0}),/descendant|text|Duplicate|Unknown/i);
    assert.equal(f.calls.length,0,scenario+' mutated before map preflight');
  }
});

test('explicit field copies verify tree structure before modifying duplicate text', () => {
  const f=anonymousGroupFixture();let target;
  f.root.Duplicate=()=>{target=f.shape(6);const g=f.shape(7);g.Shapes={Count:1,Item(){return target;}};return g;};
  const r=f.run('coreldraw_personalize_batch',{sourceId:f.root.StaticID,fields:[{name:'Title',shapeId:f.title.StaticID}],records:[{replacements:[{name:'Title',text:'Bad'}]}],offsetX:1,offsetY:0});
  assert.equal(r.partial,true);assert.match(r.error,/structure/i);assert.equal(target.Text.Story.Text,'');assert.equal(r.failed.createdShapeIds.length,1);
});

test('empty element labels are rejected before creating unusable personalization fields', () => {
  const sceneTool=workflowTools.find(t=>t.name==='coreldraw_create_scene');
  for(const variant of sceneTool.inputSchema.properties.scene.properties.elements.items.anyOf) assert.equal(variant.properties.name.minLength,1);
  const f=fixture();
  assert.throws(()=>f.run('coreldraw_create_scene',{scene:{elements:[{type:'text',name:'',x:0,y:0,text:'Title'}]}}),/name|label/i);
  assert.equal(f.all.length,0);
});
