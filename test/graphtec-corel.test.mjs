import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildCaptureOperation, buildApplyOperation, captureCorel, prepareCorel } from '../graphtec/corel.mjs';
import { documentScript } from '../src/document.mjs';

const collection = a => ({ get Count() { return a.length; }, Item: i => a[i - 1] });
const plain = v => JSON.parse(JSON.stringify(v));
const segment = (a, b, controls) => ({ Type: controls ? 1 : 0, StartNode: { PositionX: a[0], PositionY: a[1] }, EndNode: { PositionX: b[0], PositionY: b[1] }, ...(controls ? { StartingControlPointX: controls[0][0], StartingControlPointY: controls[0][1], EndingControlPointX: controls[1][0], EndingControlPointY: controls[1][1] } : {}) });
function fixture(unit = 3) {
  let next = 100;
  const pages = [], events = [], originals = [];
  const host = { CreateRGBColor: (r,g,b) => ({r,g,b}) };
  const doc = { Name: 'target', FullFileName: '', Unit: unit, Pages: collection(pages), Activate() { host.ActiveDocument = doc; }, BeginCommandGroup() { events.push('begin'); }, EndCommandGroup() { events.push('end'); }, AddPages(n) { for (let i=0;i<n;i++) makePage(); } };
  function shape(layer, type, x, y, w, h, extra = {}) {
    const s = { StaticID: next++, Name: 'object', Type: type, LeftX:x, BottomY:y, SizeWidth:w, SizeHeight:h, Layer:layer, Effects: collection([]), ...extra,
      Move(dx,dy) { this.LeftX+=dx; this.BottomY+=dy; },
      CopyToLayer(target) { const c = shape(target,this.Type,this.LeftX,this.BottomY,this.SizeWidth,this.SizeHeight,{Curve:this.Curve,Shapes:this.Shapes}); events.push(['copy',this.StaticID,c.StaticID]); return c; },
      Fill: { ApplyUniformFill(c) { this.color = c; } }, Outline: { SetNoOutline() { this.none = true; } },
    }; layer.items.unshift(s); return s;
  }
  function makePage() {
    const layers = [];
    const p = { Index:pages.length+1, Name:'Page', LeftX:pages.length ? 1000 : 0, BottomY:pages.length ? 2000 : 0, SizeWidth:200, SizeHeight:200, Layers:collection(layers), get Shapes() { return collection(layers.flatMap(l=>l.items)); }, Activate() { doc.ActivePage=p; doc.ActiveLayer=layers[0]; }, SetSize(w,h) { p.SizeWidth=w;p.SizeHeight=h; }, CreateLayer(name) { const l={Name:name,Printable:true,Visible:true,Editable:true,items:[],get Shapes(){return collection(this.items);},CreateRectangle2(x,y,w,h){return shape(l,1,x,y,w,h);}};layers.unshift(l);return l;} };
    pages.push(p); return p;
  }
  const page = makePage(), art = page.CreateLayer('Artwork'), cut = page.CreateLayer('Sticker Kiss Cut');
  const print = shape(art,5,10,20,30,40);
  const curve = shape(cut,3,10,20,30,40,{Curve:{SubPaths:collection([{Closed:true,Segments:collection([segment([10,20],[40,20]),segment([40,20],[40,60]),segment([40,60],[10,60]),segment([10,60],[10,20])])}])}});
  originals.push(print,curve);page.Activate();host.Documents=collection([doc]);host.ActiveDocument=doc;
  return {host,doc,page,art,cut,curve,print,pages,events,originals,shape};
}
function run(op, f) { return plain(vm.runInNewContext(`(function(){${documentScript(op.args,op.body,op)}\n})()`,{host:f.host})); }
const capture = f => run(buildCaptureOperation({document:'name:target'}),f);
const job = () => ({sheet:{widthMm:200,heightMm:250},placement:{dxMm:30,dyMm:40},registration:{lengthMm:10,thicknessMm:0.5,frame:{left:20,bottom:30,right:100,top:150},points:[{label:'P1',x:100,y:30},{label:'P2',x:100,y:150},{label:'P3',x:20,y:30},{label:'P4',x:20,y:150}],blankingRects:[{x:14,y:24,width:22,height:22},{x:84,y:24,width:22,height:22},{x:14,y:134,width:22,height:22},{x:84,y:134,width:22,height:22}]}});

test('capture extracts closed native cut paths read-only with explicit page identity',()=>{
  const f=fixture(), c=capture(f);
  assert.deepEqual(c.boundsMm,{x:10,y:20,width:30,height:40});assert.equal(c.paths.length,1);assert.equal(c.paths[0].closed,true);
  assert.deepEqual(c.paths[0].points,[{x:10,y:20},{x:40,y:20},{x:40,y:60},{x:10,y:60}]);
  assert.equal(c.source.documentId,'name:target');assert.equal(c.source.pageIndex,1);assert.equal(c.layers.length,2);assert.ok(c.fingerprint);assert.deepEqual(f.events,[]);assert.equal(f.doc.Unit,3);
});
test('capture converts inches, centimeters and points without changing document units',()=>{
  for(const [unit,mm] of [[1,25.4],[4,10],[14,25.4/72]]) {const f=fixture(unit),c=capture(f);assert.equal(c.boundsMm.x,10*mm);assert.equal(c.source.unit,unit);assert.equal(f.doc.Unit,unit);}
  const f=fixture(99);assert.throws(()=>capture(f),/unit/i);assert.deepEqual(f.events,[]);
});
test('capture flattens exact cubic controls within tolerance, including grouped curves',()=>{
  const f=fixture();f.curve.Curve.SubPaths=collection([{Closed:true,Segments:collection([segment([10,20],[40,20],[[10,60],[40,60]]),segment([40,20],[10,20])])}]);
  const group=f.shape(f.cut,7,10,20,30,40,{Shapes:collection([f.curve])});f.cut.items=f.cut.items.filter(s=>s!==f.curve);
  const c=capture(f),pts=c.paths[0].points;assert.ok(pts.length>10);assert.equal(c.paths[0].sourceId,`${f.curve.StaticID}:1`);assert.equal(c.layers[0].objects[0].id,group.StaticID);
  for(let i=0;i<=1000;i++){const t=i/1000,u=1-t,x=10*u*u*u+30*u*u*t+120*u*t*t+40*t*t*t,y=20*u*u*u+180*u*u*t+180*u*t*t+20*t*t*t;let distance=Infinity;for(let j=0;j<pts.length;j++){const a=pts[j],b=pts[(j+1)%pts.length],dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy,k=den?Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/den)):0;distance=Math.min(distance,Math.hypot(x-a.x-k*dx,y-a.y-k*dy));}assert.ok(distance<=0.025001);}
});
test('capture refuses open, noncurve, effects and missing cubic controls before edits',()=>{
  for(const change of [f=>{f.curve.Curve.SubPaths.Item(1).Closed=false;},f=>{f.curve.Type=1;},f=>{f.curve.Effects=collection([{}]);},f=>{const s=f.curve.Curve.SubPaths.Item(1).Segments.Item(1);s.Type=1;},f=>{f.curve.PowerClip={Shapes:collection([{}])};}]){const f=fixture();change(f);assert.throws(()=>capture(f),/open|closed|curve|effect|control|clip|unsupported/i);assert.equal(f.pages.length,1);assert.deepEqual(f.events,[]);}
});
test('capture rejects ambiguous cut layers, excessive paths, and native byte budgets',()=>{
  const a=fixture();a.page.CreateLayer('Sticker Kiss Cut');assert.throws(()=>capture(a),/ambiguous/i);
  const b=fixture();b.curve.Curve.SubPaths=collection(Array.from({length:101},()=>b.curve.Curve.SubPaths.Item(1)));assert.throws(()=>capture(b),/100|path/i);
  const c=fixture();c.print.Name='x'.repeat(270000);assert.throws(()=>capture(c),/budget|byte|name|size/i);
});
test('apply appends an actual-size page, copies source objects and creates printable filled marks',()=>{
  const f=fixture(),c=capture(f),before=plain(f.originals.map(s=>[s.StaticID,s.LeftX,s.BottomY,s.SizeWidth,s.SizeHeight]));
  const out=run(buildApplyOperation(c,job()),f),p=f.pages[1];
  assert.equal(out.pageIndex,2);assert.equal(f.doc.Unit,3);assert.equal(p.SizeWidth,200);assert.equal(p.SizeHeight,250);
  assert.deepEqual(plain(f.originals.map(s=>[s.StaticID,s.LeftX,s.BottomY,s.SizeWidth,s.SizeHeight])),before);
  const art=p.Layers.Item(3),cut=p.Layers.Item(2),marks=p.Layers.Item(1);
  assert.equal(art.Name,'Artwork');assert.equal(cut.Name,'Sticker Kiss Cut');assert.equal(cut.Printable,false);assert.equal(marks.Printable,true);
  assert.equal(art.items[0].LeftX,1040);assert.equal(art.items[0].BottomY,2060);assert.equal(art.items[0].SizeWidth,30);
  assert.equal(marks.items.length,12);assert.ok(marks.items.every(s=>s.Outline.none));assert.equal(marks.items.filter(s=>s.Fill.color.r===0).length,8);
});
test('apply verifies inches, new page origins and copy size preservation',()=>{
  const f=fixture(1),c=capture(f);run(buildApplyOperation(c,job()),f);assert.ok(Math.abs(f.pages[1].SizeWidth-200/25.4)<1e-9);assert.ok(Math.abs(f.pages[1].Layers.Item(3).items[0].LeftX-(1010+30/25.4))<1e-9);
  const b=fixture(),bc=capture(b);b.print.CopyToLayer=target=>{const copy=b.shape(target,5,10,20,31,40);return copy;};assert.throws(()=>run(buildApplyOperation(bc,job()),b),/copy|size|bounds|alignment/i);
});
test('apply rechecks source geometry, layer flags, page and identity before adding a page',()=>{
  for(const change of [f=>{f.print.LeftX++;},f=>{f.cut.Printable=false;},f=>{f.curve.Curve.SubPaths.Item(1).Segments.Item(1).EndNode.PositionX++;},f=>{f.doc.Unit=1;},f=>{f.doc.Name='renamed';}]) {const f=fixture(),c=capture(f);change(f);assert.throws(()=>run(buildApplyOperation(c,job()),f),/changed|stale|not found|source|continuous|closed/i);assert.equal(f.pages.length,1);assert.equal(f.events.filter(e=>Array.isArray(e)).length,0);}
});
test('apply verifies layer print flags and page count readback',()=>{
  const f=fixture(),c=capture(f);f.doc.AddPages=()=>{};assert.throws(()=>run(buildApplyOperation(c,job()),f),/page.*count/i);
  const g=fixture(),gc=capture(g),add=g.doc.AddPages;g.doc.AddPages=n=>{add(n);const p=g.pages[1],create=p.CreateLayer;p.CreateLayer=name=>{const l=create(name);if(name==='Sticker Kiss Cut')Object.defineProperty(l,'Printable',{get:()=>true,set:()=>{}});return l;};};assert.throws(()=>run(buildApplyOperation(gc,job()),g),/print/i);
});
test('bridge capture and prepare use separate bounded operations and return the shared job',async()=>{
  const f=fixture(),calls=[],bridge={async run(code){calls.push(code);return plain(vm.runInNewContext(`(function(){${code}\n})()`,{host:f.host}));}};
  const c=await captureCorel(bridge,{document:'name:target'});assert.equal(c.source.pageIndex,1);assert.equal(calls.length,1);
  const result=await prepareCorel(bridge,{document:'name:target',sheetWidthMm:200,sheetHeightMm:250});assert.equal(result.job.format,'graphtec-print-cut');assert.equal(result.native.pageIndex,2);assert.equal(calls.length,3);
});

test('native Type 2 mark fills cover the miter corner without extending inward endpoints',()=>{
  const f=fixture(),c=capture(f);run(buildApplyOperation(c,job()),f);
  const black=f.pages[1].Layers.Item(1).items.filter(s=>s.Fill.color.r===0);
  const p1=black.filter(s=>s.LeftX>=1089&&s.LeftX<=1101&&s.BottomY>=2029&&s.BottomY<=2041);
  const covered=p1.some(s=>1100.2>=s.LeftX&&1100.2<=s.LeftX+s.SizeWidth&&2029.8>=s.BottomY&&2029.8<=s.BottomY+s.SizeHeight);
  assert.equal(covered,true);assert.ok(p1.every(s=>s.LeftX>=1090&&s.BottomY+s.SizeHeight<=2040));
});

test('capture uses documented GetPointAt Point x/y when native nodes are unavailable',()=>{
  const f=fixture(),segments=f.curve.Curve.SubPaths.Item(1).Segments;
  for(let i=1;i<=segments.Count;i++){const s=segments.Item(i),a=s.StartNode,b=s.EndNode;delete s.StartNode;delete s.EndNode;s.GetPointAt=t=>({x:a.PositionX+(b.PositionX-a.PositionX)*t,y:a.PositionY+(b.PositionY-a.PositionY)*t});}
  assert.deepEqual(capture(f).paths[0].points,[{x:10,y:20},{x:40,y:20},{x:40,y:60},{x:10,y:60}]);
});
test('capture bounds both flattened points and UTF8 response size',()=>{
  const f=fixture(),segs=[];for(let i=0;i<50;i++){const a=2*Math.PI*i/50,b=2*Math.PI*(i+1)/50;segs.push(segment([25+15*Math.cos(a),40+20*Math.sin(a)],[25+15*Math.cos(b),40+20*Math.sin(b)]));}
  f.curve.Curve.SubPaths=collection(Array.from({length:100},()=>({Closed:true,Segments:collection(segs)})));
  assert.throws(()=>capture(f),/4000|point|budget/i);assert.deepEqual(f.events,[]);
  const g=fixture();for(let i=0;i<60;i++)g.shape(g.art,5,0,0,1,1,{Name:'😀'.repeat(1000)});
  assert.throws(()=>capture(g),/byte|budget/i);assert.deepEqual(g.events,[]);
});
test('apply detects same-bounds printable curve edits before page creation',()=>{
  const f=fixture();f.print.Type=3;f.print.Curve={SubPaths:collection([{Closed:true,Segments:collection([segment([10,20],[40,20],[[10,60],[40,60]]),segment([40,20],[10,20])])}])};
  const c=capture(f);f.print.Curve.SubPaths.Item(1).Segments.Item(1).StartingControlPointX++;
  assert.throws(()=>run(buildApplyOperation(c,job()),f),/source.*changed/i);assert.equal(f.pages.length,1);
});

test('pre-aborted capture and preparation dispatch no native calls',async()=>{
  for(const operation of [captureCorel,prepareCorel]){
    const controller=new AbortController();controller.abort();let calls=0;
    const bridge={async run(){calls++;throw new Error('unexpected dispatch');}};
    await assert.rejects(operation(bridge,{document:'name:target'},{signal:controller.signal}),{name:'AbortError'});
    assert.equal(calls,0);
  }
});
test('cancellation during read-only capture prevents preparation edits',async()=>{
  const f=fixture(),controller=new AbortController(),calls=[];
  const bridge={async run(code,options){calls.push(options);const value=plain(vm.runInNewContext(`(function(){${code}\n})()`,{host:f.host}));controller.abort();return value;}};
  await assert.rejects(prepareCorel(bridge,{document:'name:target'},{signal:controller.signal}),{name:'AbortError'});
  assert.equal(calls.length,1);assert.equal(calls[0].signal,controller.signal);assert.equal(f.pages.length,1);assert.deepEqual(f.events,[]);
});
test('prepare forwards cancellation signal to both bridge calls',async()=>{
  const f=fixture(),controller=new AbortController(),calls=[];
  const bridge={async run(code,options){calls.push(options);return plain(vm.runInNewContext(`(function(){${code}\n})()`,{host:f.host}));}};
  const result=await prepareCorel(bridge,{document:'name:target'},{signal:controller.signal});
  assert.equal(result.native.pageIndex,2);assert.equal(calls.length,2);assert.ok(calls.every(options=>options.signal===controller.signal));
});
test('completed native mutation retains its job when cancellation arrives after dispatch',async()=>{
  const f=fixture(),controller=new AbortController();let calls=0;
  const bridge={async run(code){calls++;const value=plain(vm.runInNewContext(`(function(){${code}\n})()`,{host:f.host}));if(calls===2)controller.abort();return value;}};
  const result=await prepareCorel(bridge,{document:'name:target'},{signal:controller.signal});
  assert.equal(result.native.pageIndex,2);assert.equal(result.job.format,'graphtec-print-cut');assert.equal(f.pages.length,2);
});
