import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildOperation } from '../src/tools.mjs';

function fixture() {
  const events = [], shapes = [];
  const collection = values => ({ get Count() { return values.length; }, Item(i) { return values[i-1]; } });
  const doc = { Name: 'Disposable', FullFileName: '', ActiveLayer: {},
    ActivePage: { Shapes: collection(shapes) },
    BeginCommandGroup() { events.push('begin'); }, EndCommandGroup() { events.push('end'); } };
  const host = { Documents: collection([doc]), ActiveDocument: doc };
  doc.Activate = () => { host.ActiveDocument = doc; };
  function shape(id, type = 1) {
    const item = { StaticID: id, Type: type, Name: '', LeftX: id, BottomY: 0, SizeWidth: 10, SizeHeight: 5,
      Duplicate(x,y) { events.push(['duplicate',id,x,y]); return shape(100 + events.length); },
      Delete() { events.push(['delete',id]); },
      ConvertToCurves() { events.push(['convert',id]); item.Type = 3; },
    };
    if (type === 6) item.Text = { Story: { Text: 'Original', Font: 'Arial', Size: 12 } };
    shapes.push(item); return item;
  }
  shape(1); shape(2,6);
  return { host, doc, shapes, events, shape, collection };
}
async function run(name,args,ctx) {
  const operation = await buildOperation('coreldraw_' + name,args);
  return JSON.parse(JSON.stringify(vm.runInNewContext('(function(){'+operation.code+'})()', {host:ctx.host})));
}

test('duplicate preserves originals and offsets each copy from its source',async()=>{
  const ctx=fixture();
  const result=await run('duplicate_objects',{ids:[1],dx:15,dy:-2,copies:2},ctx);
  assert.deepEqual(ctx.events.filter(Array.isArray),[['duplicate',1,15,-2],['duplicate',1,30,-4]]);
  assert.equal(result.copies.length,2);
  assert.equal(result.copies[0].sourceId,1);
  assert.equal(result.partial,false);
});
test('mutation resolves all ids before touching objects',async()=>{
  for(const name of ['duplicate_objects','delete_objects','convert_to_curves','set_text']) {
    const ctx=fixture();
    await assert.rejects(run(name,{ids:[2,999],...(name==='set_text'?{text:'Changed'}:{})},ctx),/not found/);
    assert.equal(ctx.events.filter(Array.isArray).length,0);
    assert.equal(ctx.shapes[1].Text.Story.Text,'Original');
  }
});
test('ancestor plus descendant selection is rejected before mutation',async()=>{
  const ctx=fixture(),child={StaticID:7,Type:1};
  const group=ctx.shape(6,7); group.Shapes=ctx.collection([child]);
  await assert.rejects(run('delete_objects',{ids:[6,7]},ctx),/overlap|ancestor/i);
  assert.equal(ctx.events.filter(Array.isArray).length,0);
});
test('delete exposes completed ids when a native deletion fails',async()=>{
  const ctx=fixture();ctx.shapes[1].Delete=()=>{throw new Error('Locked object');};
  const result=await run('delete_objects',{ids:[1,2]},ctx);
  assert.equal(result.partial,true);assert.equal(result.status,'failed');
  assert.deepEqual(result.completed,[1]);assert.equal(result.failedId,2);
  assert.match(result.error,/Locked object/);
  assert.equal(ctx.events.at(-1),'end');
});
test('delete does not read a native shape after its handle is invalidated',async()=>{
  const ctx=fixture(),target=ctx.shapes[0];let deleted=false;
  Object.defineProperty(target,'StaticID',{get(){if(deleted)throw new Error('Native object deleted');return 1;}});
  target.Delete=()=>{deleted=true;};
  const result=await run('delete_objects',{ids:[1]},ctx);
  assert.deepEqual(result.completed,[1]);assert.equal(result.partial,false);
});
test('duplicate failure reports copies that already exist and never retries',async()=>{
  const ctx=fixture(); let attempts=0;
  ctx.shapes[0].Duplicate=()=>{if(++attempts===2)throw new Error('Native failed');return {StaticID:50,Type:1};};
  const result=await run('duplicate_objects',{ids:[1],copies:3},ctx);
  assert.equal(attempts,2);assert.equal(result.copies[0].shape.shapeId,50);
  assert.equal(result.partial,true);assert.equal(result.failedCopy,2);
});
test('curve conversion reads back resulting native types',async()=>{
  const ctx=fixture();const result=await run('convert_to_curves',{ids:[1,2]},ctx);
  assert.deepEqual(result.objects.map(o=>o.type),[3,3]);
  assert.equal(result.partial,false);
});
test('text inspection is bounded and does not open an undo group',async()=>{
  const ctx=fixture();ctx.shapes[1].Text.Story.Text='abcdef';
  const result=await run('get_text',{id:2,limit:3},ctx);
  assert.equal(result.text,'abc');assert.equal(result.truncated,true);assert.equal(result.length,6);
  assert.deepEqual(ctx.events,[]);
});
test('set text validates all types and verifies native readback',async()=>{
  const ctx=fixture();
  await assert.rejects(run('set_text',{ids:[2,1],text:'Changed'},ctx),/text object/i);
  assert.equal(ctx.shapes[1].Text.Story.Text,'Original');
  const result=await run('set_text',{ids:[2],text:'日本語 "quoted"\n🪵'},ctx);
  assert.equal(result.objects[0].text.text,'日本語 "quoted"\n🪵');
  Object.defineProperty(ctx.shapes[1].Text.Story,'Text',{get(){return 'Ignored';},set(){}});
  const ignored=await run('set_text',{ids:[2],text:'Changed'},ctx);
  assert.equal(ignored.partial,true);assert.match(ignored.error,/readback|ignored/i);
});
test('duplicate bounds and duplicate ids fail before editing',async()=>{
  const ctx=fixture();
  for(const args of [{ids:[1,1]},{ids:[1],copies:0},{ids:[1],copies:101},{ids:[1],dx:Infinity}]) {
    await assert.rejects(run('duplicate_objects',args,ctx));
  }
  assert.equal(ctx.events.filter(Array.isArray).length,0);
});
test('copy record bounds reject oversized batches before native duplication',async()=>{
  const ctx=fixture();
  await assert.rejects(run('duplicate_objects',{ids:[1,2],copies:100},ctx).then(()=>run('duplicate_objects',{ids:[1,2],copies:101},ctx)));
  const fresh=fixture();fresh.shape(3);
  await assert.rejects(run('duplicate_objects',{ids:[1,2,3],copies:100},fresh),/200.*cop|cop.*200/i);
  assert.equal(fresh.events.filter(Array.isArray).length,0);
});
test('large text batches keep native response summaries below 200 KiB',async()=>{
  const ctx=fixture();ctx.shapes.length=0;
  for(let id=1;id<=200;id++){const s=ctx.shape(id,6);s.Name='🪵'.repeat(500);}
  const result=await run('set_text',{ids:ctx.shapes.map(s=>s.StaticID),text:'🪵'.repeat(5000)},ctx);
  assert.equal(result.objects.length,200);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<200*1024);
  assert.equal(result.objects[0].text.truncated,true);
  assert.equal(ctx.shapes[0].Text.Story.Text.length,10000);
});
test('text read bound fits the native UTF8 response even for non-ASCII stories',async()=>{
  const ctx=fixture();ctx.shapes[1].Text.Story.Text='漢'.repeat(100000);
  await assert.rejects(run('get_text',{id:2,limit:100000},ctx),/limit/);
  const result=await run('get_text',{id:2,limit:30000},ctx);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<200*1024);assert.equal(result.truncated,true);
});
test('text inspection limits also bound JSON-escaped control characters',async()=>{
  const ctx=fixture();ctx.shapes[1].Text.Story.Text='\u0000'.repeat(100000);
  await assert.rejects(run('get_text',{id:2,limit:50000},ctx),/limit/);
  const result=await run('get_text',{id:2,limit:30000},ctx);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<200*1024);assert.equal(result.truncated,true);
});
