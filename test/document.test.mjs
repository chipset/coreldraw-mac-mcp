import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { documentScript } from '../src/document.mjs';

function fixture(names) {
  const events=[];
  const host={Documents:{Count:names.length,Item(i){return docs[i-1];}}};
  const docs=names.map(Name=>({Name,FullFileName:'',Unit:3,Pages:{Count:1},ActivePage:{Shapes:{Count:0}},ActiveLayer:{},
    Activate(){host.ActiveDocument=this;events.push(Name);},BeginCommandGroup(){events.push('begin');},EndCommandGroup(){events.push('end');}}));
  host.ActiveDocument=docs[0];
  return {host,docs,events};
}
const run=(args,body,host,mutates=true)=>vm.runInNewContext('(function(){'+documentScript(args,body,{mutates,label:'Test'})+'})()', {host});

test('explicit target survives a different active document',()=>{
  const {host,events}=fixture(['One','Two']);
  assert.equal(run({document:'name:Two'},'return doc.Name;',host),'Two');
  assert.deepEqual(events,['Two','begin','end']);
});
test('ambiguous or missing target fails before edits',()=>{
  const {host,events}=fixture(['Same','Same']);
  assert.throws(()=>run({},'throw new Error("edited");',host),/document.*required/i);
  assert.throws(()=>run({document:'Same'},'return 1;',host),/ambiguous/i);
  assert.throws(()=>run({document:'Missing'},'return 1;',host),/not found/i);
  assert.deepEqual(events,[]);
});
test('command group closes on failure and describes partial edits',()=>{
  const {host,events}=fixture(['One']);
  assert.throws(()=>run({},'throw new Error("native failure");',host),/native failure.*Undo/i);
  assert.deepEqual(events,['One','begin','end']);
});
test('shape lookup is recursive and refuses missing ids',()=>{
  const {host,docs}=fixture(['One']);
  const shape={StaticID:8,Type:1};
  const group={StaticID:3,Type:7,Shapes:{Count:1,Item(){return shape;}}};
  docs[0].ActivePage.Shapes={Count:1,Item(){return group;}};
  assert.equal(run({},'return getShape(8).StaticID;',host,false),8);
  assert.throws(()=>run({},'return getShape(99);',host,false),/99.*not found/i);
});
test('object descriptions copy bounded styles and text without native objects',()=>{
  const {host}=fixture(['One']);
  const s={StaticID:9,Type:6,Name:'Title',Fill:{Type:1,UniformColor:{HexValue:'FF8800'}},Outline:{Width:.2,Color:{HexValue:'000000'}},Text:{Story:{Text:'x'.repeat(800),Font:'Arial',Size:12,Bold:true,Italic:false}}};
  host.testShape=s;
  const result=run({},'return describeShape(host.testShape);',host,false);
  assert.equal(result.fill.type,1);assert.equal(result.fill.color,'FF8800');
  assert.equal(result.outline.width,.2);assert.equal(result.text.text.length,500);assert.equal(result.text.truncated,true);
});
test('ignored native name setters expose an explicit operation-scoped manifest label',()=>{
  const {host}=fixture(['One']);
  const shape={StaticID:11,Type:1,get Name(){return '';},set Name(value){}};
  host.testShape=shape;
  const result=run({},'setShapeName(host.testShape,"Title");return describeShape(host.testShape);',host,false);
  assert.equal(result.name,'Title');assert.equal(result.namePersistence,'manifest');assert.equal(result.nativeName,'');
  assert.equal(run({},'return describeShape(host.testShape).name;',host,false),'');
});
