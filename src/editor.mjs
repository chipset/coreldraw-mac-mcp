// CorelDRAW 2021 API references: https://community.coreldraw.com/sdk/api/draw/23/
// m/{curve.createsubpath,subpath.appendcurvesegment2,fill.applyfountainfill,
// outline.setproperties,shape.weld,shape.trim,shape.intersect,shape.createcontour}
// Native methods are checked at runtime because availability differs on macOS.
const coordinate = { type: 'number', minimum: -1e6, maximum: 1e6 };
const size = { type: 'number', exclusiveMinimum: 0, maximum: 1e6 };
const boolean = { type: 'boolean' };
const name = { type: 'string', minLength: 1, maxLength: 255 };
const hex = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const array = (items, minItems = 1, maxItems = 1000) => ({ type: 'array', items, minItems, maxItems });
const point = object({ x: coordinate, y: coordinate }, ['x', 'y']);
const ids = array({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const enumeration = values => ({ type: 'string', enum: values });
const fill = { anyOf: [hex, { type: 'string', enum: ['none'] }, object({ start: hex, end: hex, angle: coordinate }, ['start', 'end'])] };
const segment = { anyOf: [
  object({ type: { type: 'string', enum: ['line'] }, x: coordinate, y: coordinate }, ['type', 'x', 'y']),
  object({ type: { type: 'string', enum: ['cubic'] }, x: coordinate, y: coordinate, c1: point, c2: point }, ['type', 'x', 'y', 'c1', 'c2'])
] };
const tool = (suffix, description, properties, required = [], readOnly = false) => ({
  name: `coreldraw_${suffix}`, description, inputSchema: object(properties, required),
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false }
});

export const editorTools = [
  tool('list_objects', 'List active-page objects with scalar bounds and optional group recursion. Returns explicit truncation; maximum 1000 objects.', { recursive: boolean, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, [], true),
  tool('list_layers', 'List up to 1000 layers on the target active page, including edit/visibility/print flags.', {}, [], true),
  tool('create_layer', 'Create a uniquely named layer on the target page. Activate it only when activate is true.', { name, activate: boolean }, ['name']),
  tool('select_objects', 'Replace selection with the specified target-page StaticIDs. Missing or duplicate IDs fail before selection changes.', { ids }, ['ids']),
  tool('create_path', 'Create a native curve with line/cubic subpaths. Coordinates and control points are absolute document units; at most 1000 total segments.', { name, subpaths: array(object({ start: point, segments: array(segment), closed: boolean }, ['start', 'segments'])) }, ['subpaths']),
  tool('create_polygon', 'Create one closed native curve from at least three vertices in document units.', { name, points: array(point, 3) }, ['points']),
  tool('style_objects', 'Style objects with RGB fill/no fill or a two-color linear gradient, outline width/color, and 0–100 percent transparency. Outline width uses current document units.', { ids, fill, outline: object({ color: { anyOf: [hex, { type: 'string', enum: ['none'] }] }, width: { type: 'number', minimum: 0, maximum: 1e4 } }), transparency: { type: 'number', minimum: 0, maximum: 100 } }, ['ids']),
  tool('style_text', 'Apply whole-story font, point size, bold, italic and paragraph alignment. All IDs must refer to text objects.', { ids, font: name, size: { type: 'number', exclusiveMinimum: 0, maximum: 10000 }, bold: boolean, italic: boolean, align: enumeration(['left', 'center', 'right', 'justify']) }, ['ids']),
  tool('transform_objects', 'Transform objects collectively: optional width/height resize, relative rotation in degrees, then position the resulting lower-left at x/y. Omitted dimensions retain current size.', { ids, x: coordinate, y: coordinate, width: size, height: size, rotation: { type: 'number', minimum: -36000, maximum: 36000 } }, ['ids']),
  tool('arrange_objects', 'Align to selection-union edges/centers or distribute equal gaps while keeping exterior objects fixed. Distribution requires at least three objects and rejects contained exterior bounds before editing.', { ids, mode: enumeration(['left', 'right', 'top', 'bottom', 'center_x', 'center_y', 'distribute_x', 'distribute_y']) }, ['ids', 'mode']),
  tool('group_objects', 'Group target objects, or ungroup the specified groups one level. Returns resulting object IDs.', { ids, action: enumeration(['group', 'ungroup']) }, ['ids', 'action']),
  tool('order_objects', 'Move objects to the front or back of their own layer, preserving selected objects relative order within each layer.', { ids, position: enumeration(['front', 'back']) }, ['ids', 'position']),
  tool('combine_shapes', 'Weld, trim or intersect exactly two objects. First ID is source; second is target. Originals are removed unless keepOriginals is true.', { ids: { ...ids, minItems: 2, maxItems: 2 }, operation: enumeration(['weld', 'trim', 'intersect']), keepOriginals: boolean }, ['ids', 'operation']),
  tool('contour', 'Apply a native inside/outside/to-center contour effect in document units. Optional RGB colors default to source outline and solid fill; non-solid fills default to white. Returns source IDs and effect count without separating the effect.', { ids, direction: enumeration(['inside', 'outside', 'center']), offset: size, steps: { type: 'integer', minimum: 1, maximum: 100 }, outlineColor: hex, fillColor: hex, endFillColor: hex }, ['ids', 'direction', 'offset'])
];

const helpers = `
// Native Corel proxies report typeof method === 'undefined' even for callable APIs.
function requireApiObject(value,method){if(!value)throw new Error('Unsupported CorelDRAW API object for '+method);}
function rangeItems(range){var out=[];if(range.Count>1000)throw new Error('Operation exceeds 1000 objects');for(var i=1;i<=range.Count;i++)out.push(range.Item(i));return out;}
function selectedShapes(){return rangeItems(getShapes(args.ids));}
function describeAll(shapes){var out=[];for(var i=0;i<shapes.length;i++)out.push(describeShape(shapes[i]));return out;}
function bounds(s){var x=Number(s.LeftX),y=Number(s.BottomY),w=Number(s.SizeWidth),h=Number(s.SizeHeight);if(!isFinite(x)||!isFinite(y)||!isFinite(w)||!isFinite(h))throw new Error('Object bounds unavailable');return {x:x,y:y,w:w,h:h};}
`;

const bodies = {
  list_objects: `
var objects=[],limit=args.limit===undefined?1000:args.limit,truncated=false,visited={};
function walk(shapes,parentId,depth){
  if(depth>30)throw new Error('Shape nesting exceeds safety bound');
  for(var i=1;i<=shapes.Count;i++){
    if(objects.length>=limit){truncated=true;return;}
    var s=shapes.Item(i),id=s.StaticID;
    if(visited[id])throw new Error('Repeated StaticID in object inventory');visited[id]=true;
    var result=describeShape(s);result.parentId=parentId;objects.push(result);
    if(args.recursive!==false&&s.Type===7&&s.Shapes&&s.Shapes.Count){walk(s.Shapes,id,depth+1);if(truncated)return;}
  }
}
walk(page.Shapes,null,0);return {objects:objects,truncated:truncated};`,
  list_layers: `
var layers=[],count=page.Layers.Count,limit=Math.min(count,1000);
for(var i=1;i<=limit;i++){var l=page.Layers.Item(i);layers.push({index:i,name:String(l.Name),visible:!!l.Visible,editable:!!l.Editable,printable:!!l.Printable,shapeCount:l.Shapes.Count});}
return {layers:layers,truncated:count>limit};`,
  create_layer: `
if(page.Layers.Count>1000)throw new Error('Layer count exceeds safety bound');
for(var i=1;i<=page.Layers.Count;i++)if(String(page.Layers.Item(i).Name)===args.name)throw new Error('Layer name already exists: '+args.name);
requireApiObject(page,'CreateLayer');var created=page.CreateLayer(args.name);
if(!created)throw new Error('CreateLayer returned no layer');
if(args.activate===true){requireApiObject(created,'Activate');created.Activate();}
return {name:String(created.Name),active:args.activate===true};`,
  select_objects: `var range=getShapes(args.ids);requireApiObject(range,'CreateSelection');range.CreateSelection();return {objects:describeAll(rangeItems(range))};`,
  create_path: `
var total=0;
for(var i=0;i<args.subpaths.length;i++){var p=args.subpaths[i];total+=p.segments.length;for(var j=0;j<p.segments.length;j++){var seg=p.segments[j];if(seg.type==='cubic'&&(!seg.c1||!seg.c2))throw new Error('Cubic segment requires c1 and c2 control points');}}
if(total>1000)throw new Error('Path exceeds 1000 segments');
requireApiObject(host,'CreateCurve');requireApiObject(layer,'CreateCurve');var curve=host.CreateCurve(doc);requireApiObject(curve,'CreateSubPath');
for(var i=0;i<args.subpaths.length;i++){
  var p=args.subpaths[i],sp=curve.CreateSubPath(p.start.x,p.start.y);
  for(var j=0;j<p.segments.length;j++){var seg=p.segments[j];
    if(seg.type==='line'){requireApiObject(sp,'AppendLineSegment');sp.AppendLineSegment(seg.x,seg.y,false);}
    else if(seg.type==='cubic'){requireApiObject(sp,'AppendCurveSegment2');sp.AppendCurveSegment2(seg.x,seg.y,seg.c1.x,seg.c1.y,seg.c2.x,seg.c2.y,false);}
    else throw new Error('Unsupported path segment type');
  }sp.Closed=p.closed===true;
}
var created=layer.CreateCurve(curve);if(!created)throw new Error('CreateCurve returned no shape');if(args.name!==undefined)setShapeName(created,args.name);return describeShape(created);`,
  create_polygon: `
requireApiObject(host,'CreateCurve');requireApiObject(layer,'CreateCurve');var curve=host.CreateCurve(doc);requireApiObject(curve,'CreateSubPath');
var first=args.points[0],sp=curve.CreateSubPath(first.x,first.y);requireApiObject(sp,'AppendLineSegment');
for(var i=1;i<args.points.length;i++)sp.AppendLineSegment(args.points[i].x,args.points[i].y,false);
sp.Closed=true;var created=layer.CreateCurve(curve);if(!created)throw new Error('CreateCurve returned no shape');if(args.name!==undefined)setShapeName(created,args.name);return describeShape(created);`,
  style_objects: `
if(args.fill===undefined&&args.outline===undefined&&args.transparency===undefined)throw new Error('At least one style property is required');
if(args.outline&&args.outline.color===undefined&&args.outline.width===undefined)throw new Error('Outline requires a color or width property');
if(args.outline&&args.outline.color==='none'&&args.outline.width!==undefined)throw new Error('No outline cannot also specify width');
var shapes=selectedShapes();
for(var i=0;i<shapes.length;i++){var s=shapes[i];
  if(args.fill!==undefined)requireApiObject(s.Fill,typeof args.fill==='object'?'ApplyFountainFill':args.fill==='none'?'ApplyNoFill':'ApplyUniformFill');
  if(args.outline){if(args.outline.color==='none')requireApiObject(s.Outline,'SetNoOutline');else requireApiObject(s.Outline,'SetProperties');}
  if(args.transparency!==undefined)requireApiObject(s.Transparency,'ApplyUniformTransparency');
}
for(var i=0;i<shapes.length;i++){var s=shapes[i];
  if(args.fill!==undefined){if(typeof args.fill==='object')s.Fill.ApplyFountainFill(color(args.fill.start),color(args.fill.end),1,args.fill.angle||0);else if(args.fill==='none')s.Fill.ApplyNoFill();else s.Fill.ApplyUniformFill(color(args.fill));}
  if(args.outline){var o=args.outline;if(o.color==='none')s.Outline.SetNoOutline();else s.Outline.SetProperties(o.width===undefined?-1:o.width,undefined,o.color===undefined?undefined:color(o.color));}
  if(args.transparency!==undefined)s.Transparency.ApplyUniformTransparency(args.transparency);
}return {objects:describeAll(shapes)};`,
  style_text: `
if(args.font===undefined&&args.size===undefined&&args.bold===undefined&&args.italic===undefined&&args.align===undefined)throw new Error('At least one text style property is required');
var shapes=selectedShapes();for(var i=0;i<shapes.length;i++)if(shapes[i].Type!==6||!shapes[i].Text||!shapes[i].Text.Story)throw new Error('Every selected object must be text');
var aligns={left:1,right:2,center:3,justify:4};
for(var i=0;i<shapes.length;i++){var t=shapes[i].Text.Story;if(args.font!==undefined)t.Font=args.font;if(args.size!==undefined)t.Size=args.size;if(args.bold!==undefined)t.Bold=args.bold;if(args.italic!==undefined)t.Italic=args.italic;if(args.align!==undefined)t.Alignment=aligns[args.align];}
return {objects:describeAll(shapes)};`,
  transform_objects: `
if(args.x===undefined&&args.y===undefined&&args.width===undefined&&args.height===undefined&&args.rotation===undefined)throw new Error('At least one transform property is required');
var range=getShapes(args.ids);
if(args.width!==undefined||args.height!==undefined)requireApiObject(range,'SetSize');
if(args.rotation!==undefined)requireApiObject(range,'Rotate');
if(args.x!==undefined||args.y!==undefined)requireApiObject(range,'Move');
if(args.width!==undefined||args.height!==undefined)range.SetSize(args.width===undefined?range.SizeWidth:args.width,args.height===undefined?range.SizeHeight:args.height);
if(args.rotation!==undefined)range.Rotate(args.rotation);
if(args.x!==undefined||args.y!==undefined)range.Move(args.x===undefined?0:args.x-range.LeftX,args.y===undefined?0:args.y-range.BottomY);
return {objects:describeAll(rangeItems(range))};`,
  arrange_objects: `
var shapes=selectedShapes(),entries=[],left=Infinity,right=-Infinity,bottom=Infinity,top=-Infinity;
for(var i=0;i<shapes.length;i++){requireApiObject(shapes[i],'Move');var b=bounds(shapes[i]);entries.push({shape:shapes[i],b:b,index:i});left=Math.min(left,b.x);right=Math.max(right,b.x+b.w);bottom=Math.min(bottom,b.y);top=Math.max(top,b.y+b.h);}
var horizontal=args.mode==='distribute_x',vertical=args.mode==='distribute_y';
if(horizontal||vertical){
  if(entries.length<3)throw new Error('Distribution requires at least three objects');
  entries.sort(function(a,b){var d=horizontal?a.b.x-b.b.x:a.b.y-b.b.y;return d||a.index-b.index;});
  var first=entries[0],last=entries[entries.length-1],sum=0;
  if((horizontal?last.b.x+last.b.w:last.b.y+last.b.h)<(horizontal?right:top)-1e-9)throw new Error('Distribution cannot preserve outer bounds when an interior object contains the last exterior edge');
  for(var i=0;i<entries.length;i++)sum+=horizontal?entries[i].b.w:entries[i].b.h;
  var start=horizontal?first.b.x:first.b.y,end=horizontal?last.b.x+last.b.w:last.b.y+last.b.h,gap=(end-start-sum)/(entries.length-1),cursor=start;
  for(var i=0;i<entries.length;i++){var e=entries[i];if(i>0&&i<entries.length-1)e.shape.Move(horizontal?cursor-e.b.x:0,vertical?cursor-e.b.y:0);cursor+=(horizontal?e.b.w:e.b.h)+gap;}
}else{
  for(var i=0;i<entries.length;i++){var e=entries[i],b=e.b,dx=0,dy=0;
    if(args.mode==='left')dx=left-b.x;else if(args.mode==='right')dx=right-b.x-b.w;else if(args.mode==='bottom')dy=bottom-b.y;else if(args.mode==='top')dy=top-b.y-b.h;else if(args.mode==='center_x')dx=(left+right-b.w)/2-b.x;else if(args.mode==='center_y')dy=(bottom+top-b.h)/2-b.y;else throw new Error('Unsupported arrangement');
    e.shape.Move(dx,dy);
  }
}return {objects:describeAll(shapes)};`,
  group_objects: `
var range=getShapes(args.ids),shapes=rangeItems(range);
if(args.action==='group'){if(shapes.length<2)throw new Error('Grouping requires at least two objects');requireApiObject(range,'Group');var group=range.Group();if(!group)throw new Error('Group returned no shape');return describeShape(group);}
var outputCount=0;
for(var i=0;i<shapes.length;i++){if(shapes[i].Type!==7)throw new Error('Ungroup requires only groups');requireApiObject(shapes[i].Shapes,'UngroupEx');outputCount+=shapes[i].Shapes.Count;}
if(outputCount>1000)throw new Error('Ungroup result exceeds 1000 objects');
var result=[];for(var i=0;i<shapes.length;i++){var ungrouped=rangeItems(shapes[i].UngroupEx());if(result.length+ungrouped.length>1000)throw new Error('Ungroup result exceeds 1000 objects');for(var j=0;j<ungrouped.length;j++)result.push(ungrouped[j]);}
return {objects:describeAll(result)};`,
  order_objects: `
var shapes=selectedShapes(),method=args.position==='front'?'OrderToFront':'OrderToBack';
for(var i=0;i<shapes.length;i++)requireApiObject(shapes[i],method);
// Native ZOrder 1 is front: send backmost first to front, frontmost first to back.
shapes.sort(function(a,b){return (Number(a.ZOrder)||0)-(Number(b.ZOrder)||0);});
if(args.position==='front')shapes.reverse();
for(var i=0;i<shapes.length;i++){if(args.position==='front')shapes[i].OrderToFront();else shapes[i].OrderToBack();}return {objects:describeAll(shapes)};`,
  combine_shapes: `
if(args.ids.length!==2)throw new Error('Boolean operations require exactly two objects');
var shapes=selectedShapes(),method={weld:'Weld',trim:'Trim',intersect:'Intersect'}[args.operation];
if(!method)throw new Error('Unsupported boolean operation');requireApiObject(shapes[0],method);
var keep=args.keepOriginals===true,result;
if(args.operation==='weld')result=shapes[0].Weld(shapes[1],keep,keep);else if(args.operation==='trim')result=shapes[0].Trim(shapes[1],keep,keep);else result=shapes[0].Intersect(shapes[1],keep,keep);
if(!result)throw new Error('Boolean operation returned no shape; source geometry may not overlap');return describeShape(result);`,
  contour: `
var shapes=selectedShapes(),directions={inside:0,outside:1,center:2},colors=[];
for(var i=0;i<shapes.length;i++){
  var s=shapes[i],outline=args.outlineColor===undefined?s.Outline.Color:color(args.outlineColor),fill;
  if(args.fillColor!==undefined)fill=color(args.fillColor);else fill=s.Fill.Type===1?s.Fill.UniformColor:color('#FFFFFF');
  var endFill=args.endFillColor===undefined?fill:color(args.endFillColor);
  requireApiObject(outline,'CreateContour outline color');requireApiObject(fill,'CreateContour fill color');requireApiObject(endFill,'CreateContour end fill color');
  colors.push({outline:outline,fill:fill,endFill:endFill});
}
// The Mac proxy requires all optional arguments and actual Color objects.
for(var i=0;i<shapes.length;i++){var c=colors[i],effect=shapes[i].CreateContour(directions[args.direction],args.offset,args.steps===undefined?1:args.steps,0,c.outline,c.fill,c.endFill,0,0,0,0,0);if(!effect)throw new Error('Contour returned no effect result');}
return {objects:describeAll(shapes),effectCount:shapes.length};`
};

export function buildEditorOperation(name, args = {}) {
  const definition = editorTools.find(tool => tool.name === name);
  if (!definition) return null;
  const suffix = name.slice('coreldraw_'.length);
  return { body: helpers + 'try{' + bodies[suffix] + '}catch(error){throw new Error(\'CorelDRAW editor API operation failed: \'+String(error.message||error));}', mutates: !definition.annotations.readOnlyHint, label: `MCP ${suffix.replaceAll('_', ' ')}` };
}
