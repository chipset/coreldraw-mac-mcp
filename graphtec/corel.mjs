import { documentScript } from '../src/document.mjs';
import { createJob, validateJob } from './job.mjs';

const MAX_NATIVE_BYTES = 196608;
const MARK_LAYER = 'Graphtec Type 2 Marks';

function captureArguments(args = {}) {
  const cutLayer = args.cutLayer ?? 'Sticker Kiss Cut';
  const toleranceMm = args.toleranceMm ?? 0.025;
  if (typeof cutLayer !== 'string' || !cutLayer.length || cutLayer.length > 255 || cutLayer === MARK_LAYER) throw new Error('Invalid cut layer name');
  if (typeof toleranceMm !== 'number' || !Number.isFinite(toleranceMm) || toleranceMm < 0.001 || toleranceMm > 0.1) throw new Error('Curve tolerance must be 0.001–0.1 mm');
  if (args.document !== undefined && (typeof args.document !== 'string' || !args.document.length || args.document.length > 4096)) throw new Error('Invalid document selector');
  return { ...(args.document === undefined ? {} : { document: args.document }), cutLayer, toleranceMm };
}

// This function is serialized into the Corel host; it deliberately has no Node dependencies.
function nativeCapture(doc, args) {
  function fail(s) { throw new Error(s); }
  function finite(v, label) { if (typeof v !== 'number' || !isFinite(v) || Math.abs(v) > 1e8) fail('Unavailable or excessive ' + label); return v; }
  function count(c, limit, label) { var n = c && c.Count; if (typeof n !== 'number' || n < 0 || Math.floor(n) !== n || n > limit) fail(label + ' exceeds safety bound or is unavailable'); return n; }
  function flag(o, p) { var v = o[p]; if (v === true || v === 1 || v === -1) return true; if (v === false || v === 0) return false; fail('Layer ' + p + ' flag unavailable'); }
  function read(o, p) { try { return o[p]; } catch (e) { return undefined; } }
  function bytes(s) { return encodeURIComponent(s).replace(/%[A-F\d]{2}/gi, 'x').length; }
  var mm = { 1:25.4, 3:1, 4:10, 14:25.4/72 }[doc.Unit];
  if (!mm) fail('Unsupported document physical unit');
  var page = doc.ActivePage, pageIndex = page && page.Index, pageCount = count(doc.Pages, 10000, 'Page count');
  if (!page || pageIndex < 1 || Math.floor(pageIndex) !== pageIndex || pageIndex > pageCount) fail('Active source page identity unavailable');
  var tolerance = args.toleranceMm, paths = [], layers = [], totalPoints = 0, visited = {}, scanned = 0, raw = [], rawBytes = 0, artworkSegments = 0;
  function recordRaw(value) { rawBytes += bytes(JSON.stringify(value)); if (rawBytes > 196608) fail('Source fingerprint exceeds native byte budget'); raw.push(value); }
  function point(x, y) { return {x:finite(x, 'curve x') * mm, y:finite(y, 'curve y') * mm}; }
  function bounds(s) { return {x:finite(s.LeftX,'left bound')*mm,y:finite(s.BottomY,'bottom bound')*mm,width:finite(s.SizeWidth,'width')*mm,height:finite(s.SizeHeight,'height')*mm}; }
  function validBounds(b) { if (b.width < 0 || b.height < 0 || Math.abs(b.x)>1e6 || Math.abs(b.y)>1e6 || b.width>1e6 || b.height>1e6) fail('Object bounds exceed safety limit'); return b; }
  function same(a,b) { return Math.abs(a.x-b.x)<=1e-8 && Math.abs(a.y-b.y)<=1e-8; }
  function middle(a,b) { return {x:(a.x+b.x)/2,y:(a.y+b.y)/2}; }
  function distance(p,a,b) { var dx=b.x-a.x,dy=b.y-a.y,d=dx*dx+dy*dy,t=d?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/d)):0; return Math.sqrt(Math.pow(p.x-a.x-t*dx,2)+Math.pow(p.y-a.y-t*dy,2)); }
  function add(points,p) { if (++totalPoints > 4000) fail('Cut paths exceed 4000 point safety limit'); points.push(p); }
  function cubic(points,a,b,c,d,depth) {
    // A Bezier lies in the convex hull of its controls. Both interior controls
    // within the chord capsule prove the entire subcurve is within tolerance.
    if (Math.max(distance(b,a,d),distance(c,a,d)) <= tolerance) { add(points,d); return; }
    if (depth >= 24) fail('Cubic subdivision cannot meet curve tolerance');
    var ab=middle(a,b),bc=middle(b,c),cd=middle(c,d),abc=middle(ab,bc),bcd=middle(bc,cd),m=middle(abc,bcd);
    cubic(points,a,ab,abc,m,depth+1); cubic(points,m,bcd,cd,d,depth+1);
  }
  function endpoint(seg,start) {
    var node=read(seg,start?'StartNode':'EndNode');
    if (node && typeof read(node,'PositionX')==='number' && typeof read(node,'PositionY')==='number') return point(node.PositionX,node.PositionY);
    // CorelDRAW 2021 Segment.GetPointAt returns a Point with lowercase x/y.
    var p;try {p=seg.GetPointAt(start?0:1);}catch(e){fail('Native segment endpoints unsupported');}
    if(!p)fail('Native segment endpoints unsupported');return point(p.x,p.y);
  }
  function inspectCurve(s) {
    var curve=read(s,'Curve'),subs=curve&&curve.SubPaths,n=count(subs,100,'Cut subpath count');
    if(!n)fail('Cut curve has no subpaths');
    for(var i=1;i<=n;i++){
      if(paths.length>=100)fail('Cut paths exceed 100 path safety limit');
      var sp=subs.Item(i);if(!sp||flag(sp,'Closed')!==true)fail('Cut path must be closed; open geometry refused');
      var segments=sp.Segments,ns=count(segments,4000,'Cut segment count'),pts=[],last=null,first=null;
      if(!ns)fail('Cut path is empty');
      for(var j=1;j<=ns;j++){
        var seg=segments.Item(j),a=endpoint(seg,true),d=endpoint(seg,false),type=seg.Type;
        if(last&&!same(last,a))fail('Cut path segments are not continuous');
        if(!first){first=a;add(pts,a);}recordRaw([s.StaticID,i,j,type,a,d]);
        if(type===0)add(pts,d);
        else if(type===1){
          var b=point(read(seg,'StartingControlPointX'),read(seg,'StartingControlPointY')),c=point(read(seg,'EndingControlPointX'),read(seg,'EndingControlPointY'));
          recordRaw([b,c]);cubic(pts,a,b,c,d,0);
        }else fail('Unsupported native curve segment type');
        last=d;
      }
      if(!same(first,last))fail('Closed cut path endpoints do not close');
      pts.pop();totalPoints--;if(pts.length<3)fail('Closed cut path needs at least three points');
      paths.push({sourceId:String(s.StaticID)+':'+i,closed:true,points:pts});
    }
  }
  function inspect(s,isCut,depth) {
    if(depth>30||++scanned>3000)fail('Object traversal safety bound exceeded');
    var id=s.StaticID;if(typeof id!=='number'||id<=0||Math.floor(id)!==id||visited[id])fail('Invalid or repeated native StaticID');visited[id]=true;
    var b=validBounds(bounds(s)),name=String(s.Name||'');if(name.length>4096)fail('Object name exceeds byte budget');
    var signature={id:id,type:s.Type,name:name,boundsMm:b};
    // Capture available appearance metadata as part of the stale-source check.
    var fill=read(s,'Fill'),outline=read(s,'Outline'),text=read(read(s,'Text'),'Story');
    if(fill)signature.fill=[read(fill,'Type'),String(read(read(fill,'UniformColor'),'HexValue')||'')];
    if(outline)signature.outline=[read(outline,'Width'),read(outline,'Type'),String(read(read(outline,'Color'),'HexValue')||'')];
    if(text){var content=read(text,'Text');if(typeof content==='string'){if(content.length>20000)fail('Text fingerprint exceeds byte budget');signature.text=[content,read(text,'Font'),read(text,'Size')];}}
    recordRaw(signature);
    if(isCut){
      var effects=read(s,'Effects');if(!effects||count(effects,100,'Cut effects')!==0)fail('Cut effects unsupported; use plain native curves');
      var clip=read(s,'PowerClip');if(clip)fail('PowerClip cut geometry unsupported');
      if(s.Type===7){var children=s.Shapes,n=count(children,3000,'Group children');if(!n)fail('Cut group is empty');for(var k=1;k<=n;k++)inspect(children.Item(k),true,depth+1);}
      else if(s.Type===3)inspectCurve(s);
      else fail('Cut layer contains noncurve geometry; convert to closed native curves first');
    }else if(s.Type===7){var children=s.Shapes,n=count(children,3000,'Group children');for(var k=1;k<=n;k++)inspect(children.Item(k),false,depth+1);}
    else if(s.Type===3){
      var subs=s.Curve&&s.Curve.SubPaths,n=count(subs,1000,'Artwork subpaths');
      for(var pi=1;pi<=n;pi++){
        var sp=subs.Item(pi),segments=sp.Segments,ns=count(segments,4000,'Artwork segments');recordRaw(['artwork path',id,pi,read(sp,'Closed')]);
        for(var si=1;si<=ns;si++){
          if(++artworkSegments>4000)fail('Artwork fingerprint geometry exceeds safety bound');
          var seg=segments.Item(si),item=[id,pi,si,seg.Type,endpoint(seg,true),endpoint(seg,false)];
          if(seg.Type===1)item.push(point(read(seg,'StartingControlPointX'),read(seg,'StartingControlPointY')),point(read(seg,'EndingControlPointX'),read(seg,'EndingControlPointY')));
          recordRaw(item);
        }
      }
    }
    return {id:id,boundsMm:b};
  }
  var layerCount=count(page.Layers,1000,'Layer count'),found=0,printObjects=0,names={},left=Infinity,bottom=Infinity,right=-Infinity,top=-Infinity;
  for(var li=1;li<=layerCount;li++)if(String(page.Layers.Item(li).Name)===args.cutLayer)found++;
  if(found!==1)fail(found?'Cut layer name is ambiguous':'Exact cut layer not found: '+args.cutLayer);
  for(var li=1;li<=layerCount;li++){
    var layer=page.Layers.Item(li),name=String(layer.Name||''),isCut=name===args.cutLayer,printable=flag(layer,'Printable'),visible=flag(layer,'Visible'),editable=flag(layer,'Editable'),n=count(layer.Shapes,1000,'Layer object count');
    recordRaw(['layer',li,name,printable,visible,editable,n]);
    if(!n||!isCut&&!printable)continue;
    if(name.length>255||name==='Graphtec Type 2 Marks'||names[name])fail('Included layer names must be unique and not use the Graphtec marks name');names[name]=true;
    var entry={index:li,name:name,printable:printable,visible:visible,editable:editable,isCut:isCut,objects:[]};
    for(var si=1;si<=n;si++){
      var object=inspect(layer.Shapes.Item(si),isCut,0),b=object.boundsMm;entry.objects.push(object);
      if(!isCut)printObjects++;left=Math.min(left,b.x);bottom=Math.min(bottom,b.y);right=Math.max(right,b.x+b.width);top=Math.max(top,b.y+b.height);
    }layers.push(entry);
  }
  if(!paths.length)fail('Cut layer has no closed native paths');
  if(!printObjects)fail('No printable artwork found on source page');
  var full=String(doc.FullFileName||''),source={documentId:full?'path:'+full:'name:'+String(doc.Name||''),pageIndex:pageIndex,pageCount:pageCount,unit:doc.Unit,unitsPerMm:1/mm,pageBoundsMm:validBounds(bounds(page))};
  var result={boundsMm:{x:left,y:bottom,width:right-left,height:top-bottom},paths:paths,source:source,layers:layers,cutLayer:args.cutLayer,toleranceMm:tolerance};
  var serialized=JSON.stringify([result,raw]),h1=2166136261,h2=5381;
  if(bytes(serialized)>196608)fail('Native capture exceeds 192 KiB byte budget');
  for(var hi=0;hi<serialized.length;hi++){h1=Math.imul(h1^serialized.charCodeAt(hi),16777619);h2=Math.imul(h2,33)^serialized.charCodeAt(hi);}
  result.fingerprint=(h1>>>0).toString(16)+':'+(h2>>>0).toString(16);
  if(bytes(JSON.stringify(result))>196608)fail('Native result exceeds byte budget');return result;
}

export function buildCaptureOperation(args = {}) {
  return { args:captureArguments(args), body:`return (${nativeCapture.toString()})(doc,args);`, mutates:false, label:'Graphtec capture' };
}

export function buildApplyOperation(capture, job) {
  if (!capture?.source?.documentId || !capture.fingerprint) throw new Error('Source capture identity missing');
  // prepareCorel validates the complete shared schema. Builders also bound their
  // serialized payload so host fixtures cannot accidentally dispatch huge scripts.
  if (Buffer.byteLength(JSON.stringify({capture,job}),'utf8') > MAX_NATIVE_BYTES) throw new Error('Corel apply payload exceeds native byte budget');
  const args = { ...captureArguments({document:capture.source.documentId,cutLayer:capture.cutLayer,toleranceMm:capture.toleranceMm}), capture,job };
  return {args,mutates:true,label:'Graphtec print and cut page',body:`
var expected=args.capture,job=args.job;
var current=(${nativeCapture.toString()})(doc,args);
if(current.fingerprint!==expected.fingerprint)throw new Error('Source artwork, cut paths or page changed since capture; prepare again');
var sourcePage=doc.ActivePage,before=doc.Pages.Count,unit=expected.source.unitsPerMm,tol=unit*0.01;
function near(a,b){return typeof a==='number'&&isFinite(a)&&Math.abs(a-b)<=tol;}
function box(s){return {x:Number(s.LeftX),y:Number(s.BottomY),width:Number(s.SizeWidth),height:Number(s.SizeHeight)};}
function checkBox(s,b){var actual=box(s);if(!near(actual.x,b.x)||!near(actual.y,b.y)||!near(actual.width,b.width)||!near(actual.height,b.height))throw new Error('Copied object bounds or size verification failed');}
function printFlag(layer,value){layer.Printable=value;var flag=layer.Printable;if((value&&flag!==true&&flag!==1&&flag!==-1)||(!value&&flag!==false&&flag!==0))throw new Error('Layer printable flag verification failed');}
// Resolve every top-level reference before creating the destination page.
var resolved=[];
for(var l=0;l<expected.layers.length;l++){var source=expected.layers[l],nativeLayer=sourcePage.Layers.Item(source.index),items=[];
 for(var i=0;i<source.objects.length;i++){var object=source.objects[i],found=null;for(var j=1;j<=nativeLayer.Shapes.Count;j++){var candidate=nativeLayer.Shapes.Item(j);if(candidate.StaticID===object.id){found=candidate;break;}}
 if(!found)throw new Error('Source object reference changed before copy');items.push(found);}resolved.push(items);
}
doc.AddPages(1);
if(doc.Pages.Count!==before+1)throw new Error('New page count verification failed');
var target=doc.Pages.Item(before+1);target.SetSize(job.sheet.widthMm*unit,job.sheet.heightMm*unit);target.Activate();
if(doc.ActivePage.Index!==before+1||!near(Number(target.SizeWidth),job.sheet.widthMm*unit)||!near(Number(target.SizeHeight),job.sheet.heightMm*unit))throw new Error('Prepared page size or activation verification failed');
var originX=Number(target.LeftX),originY=Number(target.BottomY);if(!isFinite(originX)||!isFinite(originY))throw new Error('Prepared page origin unavailable');
var copyCount=0,copiedIds=[];
// Native layer/object collections are front-to-back; recreate them back-to-front.
for(var l=expected.layers.length-1;l>=0;l--){var source=expected.layers[l],targetLayer=target.CreateLayer(source.name);
 if(!targetLayer||String(targetLayer.Name)!==source.name)throw new Error('Destination layer creation failed');printFlag(targetLayer,source.isCut?false:source.printable);
 targetLayer.Visible=source.visible;
 for(var i=source.objects.length-1;i>=0;i--){var object=source.objects[i],original=resolved[l][i],copy=original.CopyToLayer(targetLayer);
 if(!copy||!copy.StaticID||copy.StaticID===original.StaticID)throw new Error('Separate artwork copy verification failed');
 var b=object.boundsMm,wanted={x:originX+(b.x+job.placement.dxMm)*unit,y:originY+(b.y+job.placement.dyMm)*unit,width:b.width*unit,height:b.height*unit};
 var previous=box(copy);if(!near(previous.width,wanted.width)||!near(previous.height,wanted.height))throw new Error('Copied object size verification failed before placement');
 copy.Move(wanted.x-previous.x,wanted.y-previous.y);checkBox(copy,wanted);copiedIds.push(copy.StaticID);copyCount++;
 }targetLayer.Editable=source.editable;
}
var marks=target.CreateLayer('Graphtec Type 2 Marks');printFlag(marks,true);
function rectangle(x,y,width,height,r,g,b){var s=marks.CreateRectangle2(originX+x*unit,originY+y*unit,width*unit,height*unit);if(!s)throw new Error('Registration rectangle creation failed');s.Fill.ApplyUniformFill(host.CreateRGBColor(r,g,b));s.Outline.SetNoOutline();checkBox(s,{x:originX+x*unit,y:originY+y*unit,width:width*unit,height:height*unit});}
var blank=job.registration.blankingRects;
for(var i=0;i<blank.length;i++){var b=blank[i];rectangle(b.x,b.y,b.width,b.height,255,255,255);}
var frame=job.registration.frame,length=job.registration.lengthMm,thickness=job.registration.thicknessMm;
for(var i=0;i<4;i++){
 var isRight=i<2,isTop=i===1||i===3,x=isRight?frame.right:frame.left,y=isTop?frame.top:frame.bottom;
 // Type 2: both legs extend inward. Overlapping filled rectangles give square corners.
 rectangle(isRight?x-length:x-thickness/2,y-thickness/2,length+thickness/2,thickness,0,0,0);
 rectangle(x-thickness/2,isTop?y-length:y-thickness/2,thickness,length+thickness/2,0,0,0);
}
if(doc.Unit!==expected.source.unit||doc.Pages.Count!==before+1)throw new Error('Document unit or page count changed unexpectedly');
// Source originals remain on their original page and retain their measured bounds.
for(var l=0;l<expected.layers.length;l++)for(var i=0;i<expected.layers[l].objects.length;i++){var b=expected.layers[l].objects[i].boundsMm;checkBox(resolved[l][i],{x:b.x*unit,y:b.y*unit,width:b.width*unit,height:b.height*unit});}
return {documentId:expected.source.documentId,sourcePageIndex:expected.source.pageIndex,pageIndex:before+1,pageCount:doc.Pages.Count,unit:doc.Unit,copyCount:copyCount,copiedIds:copiedIds,cutLayer:expected.cutLayer,markLayer:'Graphtec Type 2 Marks',marks:4};`};
}

export async function captureCorel(bridge, args = {}, { signal } = {}) {
  signal?.throwIfAborted();
  const operation = buildCaptureOperation(args);
  const capture = await bridge.run(documentScript(operation.args,operation.body,operation), { signal });
  if (Buffer.byteLength(JSON.stringify(capture),'utf8') > MAX_NATIVE_BYTES) throw new Error('Native Corel capture exceeds byte budget');
  return capture;
}

export async function prepareCorel(bridge, args = {}, { signal } = {}) {
  const capture = await captureCorel(bridge,args,{ signal });
  signal?.throwIfAborted();
  const options = Object.fromEntries(['sheetWidthMm','sheetHeightMm','lengthMm','thicknessMm','gapMm','name'].filter(key => args[key] !== undefined).map(key => [key,args[key]]));
  const job = validateJob(createJob(capture,options));
  const operation = buildApplyOperation(capture,job);
  signal?.throwIfAborted();
  const native = await bridge.run(documentScript(operation.args,operation.body,operation), { signal });
  return {job,native};
}
