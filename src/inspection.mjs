const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const positive = { type: 'number', exclusiveMinimum: 0, maximum: 1000000 };
const id = integer(1, Number.MAX_SAFE_INTEGER);
const limits = { limit: integer(1, 500), maxShapes: integer(1, 5000) };
const query = { type: 'string', minLength: 1, maxLength: 500 };
const tool = (suffix, description, properties, required = []) => ({
  name: `coreldraw_${suffix}`, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
});

export const inspectionTools = [
  tool('find_objects', 'Find active-page objects by literal name/text substrings and numeric native shape type. Filters combine with AND; case insensitive and recursive through groups by default. Returns bounded scalar metadata and explicit incomplete/truncated flags. Text search reads at most 10000 characters per story; longer stories make the scan incomplete. Object reports share a 128 KiB UTF-8 JSON budget.', {
    name: query, text: query, type: integer(0, 100000), caseSensitive: { type: 'boolean' }, recursive: { type: 'boolean' }, ...limits
  }),
  tool('inspect_curve', 'Read native nodes and subpath closure for one curve StaticID on the active page, including nested groups. Positions use document units. Unsupported collections fail clearly; unsupported scalar measurements are null with incomplete=true. Node offset defaults to 0, limit to 100, subpath bound to 100. Node and subpath arrays share a 128 KiB UTF-8 JSON budget.', {
    id, offset: integer(0, 1000000), limit: integer(1, 1000), maxSubpaths: integer(1, 500)
  }, ['id']),
  tool('production_preflight', 'Read-only active-page/group checks for requested object dimensions (document units), open curve subpaths, and bitmap DPI estimates from pixel size/axis bounds. Bitmap DPI remains unknown because transform integrity cannot be proven. Optional ids restrict roots. Reports pass/fail/unknown; incomplete or unavailable checks never pass. Defaults: tolerance 0.01, minDpi 300, maxShapes 1000, limit 100, maxSubpaths 1000. Fonts, duplicate geometry, PowerClip contents and other pages are not checked. Detail reports share a 128 KiB UTF-8 JSON budget; summary checks continue after detail truncation.', {
    ids: { type: 'array', items: id, minItems: 1, maxItems: 1000, uniqueItems: true },
    expectedWidth: positive, expectedHeight: positive, tolerance: { type: 'number', minimum: 0, maximum: 1000000 },
    minDpi: { type: 'number', exclusiveMinimum: 0, maximum: 100000 }, ...limits, maxSubpaths: integer(1, 1000)
  })
];

// Only scalar snapshots leave the host. Property getters may throw on unsupported
// Mac APIs, while native callable proxies can report typeof method === undefined.
// Share 128 KiB between report arrays, leaving space below the native 256 KiB
// response ceiling for summaries and the response envelope.
const helpers = `
function read(o,k){try{return o?o[k]:null;}catch(e){return null;}}
function finite(v){return typeof v==='number'&&isFinite(v);}
function number(v){return finite(v)?v:null;}
function scalar(v){return typeof v==='string'?v.slice(0,500):typeof v==='boolean'?v:number(v);}
function count(c){var n=read(c,'Count');return finite(n)&&n>=0&&Math.floor(n)===n?n:null;}
function item(c,i){try{return c.Item(i);}catch(e){return null;}}
var reportBytes=2;
function utf8Bytes(text){
  var bytes=0;
  for(var i=0;i<text.length;i++){
    var code=text.charCodeAt(i);
    if(code<128)bytes++;else if(code<2048)bytes+=2;
    else if(code>=55296&&code<=56319&&i+1<text.length&&text.charCodeAt(i+1)>=56320&&text.charCodeAt(i+1)<=57343){bytes+=4;i++;}
    else bytes+=3;
  }
  return bytes;
}
function appendReport(array,value){
  var bytes=utf8Bytes(JSON.stringify(value))+(array.length?1:0);
  if(reportBytes+bytes>131072)return false;
  reportBytes+=bytes;array.push(value);return true;
}
function metadata(s,parentId){
  var name=null;try{name=getShapeName(s);}catch(e){}
  return {shapeId:number(read(s,'StaticID')),type:number(read(s,'Type')),name:typeof name==='string'?name.slice(0,500):null,parentId:parentId,
    x:number(read(s,'LeftX')),y:number(read(s,'BottomY')),width:number(read(s,'SizeWidth')),height:number(read(s,'SizeHeight'))};
}
var scanned=0,incomplete=false,truncated=false,reasons=[],seen={};
function mark(reason){incomplete=true;if(reasons.indexOf(reason)<0&&reasons.length<20)reasons.push(reason);}
function walk(shapes,parentId,depth,visit){
  var n=count(shapes);if(n===null){mark('Native shape collection unavailable');return true;}
  if(depth>30&&n){mark('Group depth exceeds 30');truncated=true;return true;}
  for(var i=1;i<=n;i++){
    if(scanned>=(args.maxShapes===undefined?1000:args.maxShapes)){mark('Shape traversal bound reached');truncated=true;return false;}
    var s=item(shapes,i);scanned++;
    if(!s){mark('Native shape unavailable');continue;}
    var sid=number(read(s,'StaticID')),type=number(read(s,'Type'));
    if(sid===null||sid<=0||Math.floor(sid)!==sid)mark('StaticID unavailable');
    else{if(seen[sid]){mark('Repeated StaticID; group traversal incomplete');continue;}seen[sid]=true;}
    if(type===null)mark('Native shape type unavailable');
    if(visit(s,parentId)===false)return false;
    if(args.recursive!==false&&type===7){if(!walk(read(s,'Shapes'),sid,depth+1,visit))return false;}
  }
  return true;
}
`;

const bodies = {
  find_objects: `
var objects=[],limit=args.limit===undefined?100:args.limit;
function normalized(s){return args.caseSensitive?s:s.toLowerCase();}
function matches(value,query){return typeof value==='string'&&normalized(value).indexOf(normalized(query))>=0;}
walk(page.Shapes,null,0,function(s,parentId){
  if(objects.length>=limit){truncated=true;mark('Result limit reached before scan completion');return false;}
  var m=metadata(s,parentId),text=null;
  if(m.name===null||m.width===null||m.height===null||m.x===null||m.y===null)mark('Object scalar metadata unavailable');
  if(m.type===6){var story=read(read(s,'Text'),'Story'),nativeText=read(story,'Text');
    if(typeof nativeText==='string'){text=nativeText.slice(0,10000);if(nativeText.length>10000&&args.text!==undefined)mark('Text query exceeds 10000-character story bound');}
    else if(args.text!==undefined)mark('Native story text unavailable');
  }
  if(args.name!==undefined&&!matches(m.name,args.name)||args.type!==undefined&&m.type!==args.type||args.text!==undefined&&!matches(text,args.text))return;
  if(text!==null){m.text=text.slice(0,500);m.textTruncated=typeof nativeText==='string'&&nativeText.length>500;}
  if(!appendReport(objects,m)){truncated=true;mark('Report UTF-8 byte budget reached');return false;}
});
return {objects:objects,scanned:scanned,truncated:truncated,incomplete:incomplete,reasons:reasons,scope:args.recursive===false?'active-page root objects':'active-page objects and nested groups'};`,
  inspect_curve: `
var s=getShape(args.id);
if(read(s,'Type')!==3)throw new Error('Shape '+args.id+' is not a native curve');
var c=read(s,'Curve'),nodes=read(c,'Nodes'),paths=read(c,'SubPaths'),total=count(nodes),pathTotal=count(paths);
if(!c||total===null||pathTotal===null)throw new Error('Native curve node/subpath API unavailable or unsupported');
reportBytes=4;
var offset=args.offset===undefined?0:args.offset,limit=args.limit===undefined?100:args.limit,pathLimit=args.maxSubpaths===undefined?100:args.maxSubpaths,out=[],subs=[];
for(var i=offset+1;i<=Math.min(total,offset+limit);i++){
  var node=item(nodes,i);if(!node)throw new Error('Native curve node API unavailable at index '+i);
  var x=number(read(node,'PositionX')),y=number(read(node,'PositionY')),type=scalar(read(node,'Type')),ending=read(node,'IsEnding');
  if(x===null||y===null||type===null||typeof ending!=='boolean')mark('Native node scalar metadata unavailable');
  if(!appendReport(out,{index:i,x:x,y:y,type:type,ending:typeof ending==='boolean'?ending:null}))break;
}
for(var j=1;j<=Math.min(pathTotal,pathLimit);j++){
  var path=item(paths,j);if(!path)throw new Error('Native curve subpath API unavailable at index '+j);
  var closed=read(path,'Closed');if(typeof closed!=='boolean')mark('Native subpath closure unavailable');
  if(!appendReport(subs,{index:j,closed:typeof closed==='boolean'?closed:null}))break;
}
var nodesTruncated=offset>0||offset+out.length<total,subpathsTruncated=subs.length<pathTotal;
return {shapeId:args.id,unit:scalar(read(doc,'Unit')),total:total,offset:offset,nodes:out,subpathTotal:pathTotal,subpaths:subs,nodesTruncated:nodesTruncated,subpathsTruncated:subpathsTruncated,truncated:nodesTruncated||subpathsTruncated,reportsTruncated:nodesTruncated||subpathsTruncated,incomplete:incomplete,reasons:reasons};`,
  production_preflight: `
function check(status,reason,extra){var result={status:status,reason:reason};if(extra)for(var k in extra)result[k]=extra[k];return result;}
function na(reason){return check('pass',reason,{applicable:false});}
var unit=read(doc,'Unit'),mmPerUnit=finite(unit)?{1:25.4,3:1,4:10,14:25.4/72}[unit]:null;
var tolerance=args.tolerance===undefined?0.01:args.tolerance,minDpi=args.minDpi===undefined?300:args.minDpi,pathLimit=args.maxSubpaths===undefined?1000:args.maxSubpaths,geometryBudget=10000;
var reports=[],reportBudgetExhausted=false,limit=args.limit===undefined?100:args.limit,total=0,keys=['dimensions','openCurves','bitmapDpi'],summary={},counts={pass:0,fail:0,unknown:0};
for(var k=0;k<keys.length;k++)summary[keys[k]]=check('pass','Checked scanned scope',{pass:0,fail:0,unknown:0,applicable:false});
function inspect(s,parentId){
  var m=metadata(s,parentId),type=m.type,w=m.width,h=m.height,checks={};
  // Only these primitive/group enums are supported by this bounded preflight.
  var supportedType=type===1||type===2||type===3||type===4||type===5||type===6||type===7;
  if(args.expectedWidth===undefined&&args.expectedHeight===undefined)checks.dimensions=na('No object dimension target requested');
  else if(args.expectedWidth!==undefined&&(w===null||w<0)||args.expectedHeight!==undefined&&(h===null||h<0))checks.dimensions=check('unknown','Requested object dimension unavailable');
  else checks.dimensions=check((args.expectedWidth===undefined||Math.abs(w-args.expectedWidth)<=tolerance)&&(args.expectedHeight===undefined||Math.abs(h-args.expectedHeight)<=tolerance)?'pass':'fail','Compared object dimensions in document units',{width:w,height:h,tolerance:tolerance});
  if(type===3){
    var paths=read(read(s,'Curve'),'SubPaths'),n=count(paths),open=0,unknown=false;
    if(n===null||n<1)checks.openCurves=check('unknown','Native curve subpaths unavailable');
    else{
      var bound=Math.min(n,pathLimit,geometryBudget);if(bound<n)unknown=true;geometryBudget-=bound;
      for(var j=1;j<=bound;j++){var closed=read(item(paths,j),'Closed');if(closed===false)open++;else if(closed!==true)unknown=true;}
      checks.openCurves=check(open?'fail':unknown?'unknown':'pass',unknown?'Closure metadata unavailable or geometry bound reached':'Checked native subpath closure',{openSubpaths:open,subpathsChecked:bound,subpathTotal:n});
    }
  }else checks.openCurves=!supportedType?check('unknown','Native shape type unavailable or unsupported'):na('Shape is not a native curve');
  if(type===5){
    var bitmap=read(s,'Bitmap'),px=number(read(bitmap,'SizeWidth')),py=number(read(bitmap,'SizeHeight')),angle=number(read(s,'RotationAngle'));
    if(angle===null||Math.abs(angle%180)>0.000001)checks.bitmapDpi=check('unknown','Finite unrotated bounds required for effective DPI');
    else if(!mmPerUnit||w===null||h===null||w<=0||h<=0||px===null||py===null||px<=0||py<=0)checks.bitmapDpi=check('unknown','Positive pixel/drawn dimensions and supported physical units required');
    else{
      var dx=px/(w*mmPerUnit/25.4),dy=py/(h*mmPerUnit/25.4);
      checks.bitmapDpi=!finite(dx)||!finite(dy)?check('unknown','Axis-bound DPI estimate is not finite'):check('unknown','Axis bounds do not prove absence of shear or ancestor transforms',{estimatedDpiX:dx,estimatedDpiY:dy,minDpi:minDpi,pixelWidth:px,pixelHeight:py});
    }
  }else checks.bitmapDpi=!supportedType?check('unknown','Native shape type unavailable or unsupported'):na('Shape is not a bitmap');
  for(var k=0;k<keys.length;k++){
    var key=keys[k],entry=checks[key],aggregate=summary[key];counts[entry.status]++;aggregate[entry.status]++;
    if(entry.applicable!==false)aggregate.applicable=true;
    if(entry.status==='fail')aggregate.status='fail';else if(entry.status==='unknown'&&aggregate.status!=='fail')aggregate.status='unknown';
  }
  total++;if(reports.length<limit&&!reportBudgetExhausted){m.checks=checks;if(!appendReport(reports,m))reportBudgetExhausted=true;}
}
if(args.ids){var roots=[];for(var i=0;i<args.ids.length;i++)roots.push(getShape(args.ids[i]));walk({Count:roots.length,Item:function(i){return roots[i-1];}},null,0,inspect);}
else walk(page.Shapes,null,0,inspect);
if(total===0&&(args.expectedWidth!==undefined||args.expectedHeight!==undefined)){summary.dimensions.status='unknown';summary.dimensions.reason='No objects were available for requested dimensions';}
if(incomplete)for(var k=0;k<keys.length;k++){var aggregate=summary[keys[k]];if(aggregate.status!=='fail')aggregate.status='unknown';aggregate.reason='Object traversal incomplete';}
var passed=!incomplete;for(var k=0;k<keys.length;k++)if(summary[keys[k]].status!=='pass')passed=false;
return {scope:'active-page objects and nested groups',restrictedToIds:args.ids||null,unit:scalar(unit),total:total,scanned:scanned,items:reports,checks:summary,counts:counts,passed:passed,incomplete:incomplete,truncated:truncated,reportsTruncated:reports.length<total,reasons:reasons,notChecked:['fonts','duplicateGeometry','PowerClipContents','otherPages']};`
};

export function buildInspectionOperation(name, args = {}) {
  if (!name.startsWith('coreldraw_')) return null;
  const suffix = name.slice('coreldraw_'.length);
  if (!Object.hasOwn(bodies, suffix)) return null;
  return { body: helpers + bodies[suffix], mutates: false, label: `MCP ${suffix.replaceAll('_', ' ')}` };
}
