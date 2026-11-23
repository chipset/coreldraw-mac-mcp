// Structured fabrication and reusable-scene workflows. Native objects never leave the host.
const coordinate = { type: 'number', minimum: -1000000, maximum: 1000000 };
const positive = { type: 'number', exclusiveMinimum: 0, maximum: 1000000 };
const shortText = { type: 'string', maxLength: 1000 };
const hex = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const id = { type: 'integer', minimum: 1, maximum: 9007199254740991 };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const point = object({ x: coordinate, y: coordinate }, ['x', 'y']);
const style = { name: { ...shortText, minLength: 1 }, fill: hex, outlineColor: hex, outlineWidth: positive };
const element = { anyOf: [
  object({ type: { enum: ['rect'] }, ...style, x: coordinate, y: coordinate, width: positive, height: positive }, ['type','x','y','width','height']),
  object({ type: { enum: ['ellipse'] }, ...style, x: coordinate, y: coordinate, width: positive, height: positive }, ['type','x','y','width','height']),
  object({ type: { enum: ['polygon'] }, ...style, points: { type: 'array', items: point, minItems: 3, maxItems: 1000 } }, ['type','points']),
  object({ type: { enum: ['text'] }, ...style, x: coordinate, y: coordinate, text: { type: 'string', maxLength: 10000 }, fontSize: { type: 'number', exclusiveMinimum: 0, maximum: 1000 } }, ['type','x','y','text']),
] };
const scene = object({ elements: { type: 'array', items: element, minItems: 1, maxItems: 200 } }, ['elements']);
const sceneProperties = { template: { type: 'string', enum: ['landscape','sign'] }, scene, name: shortText, x: coordinate, y: coordinate, width: positive, height: positive, title: shortText, subtitle: shortText, group: { type: 'boolean' } };
const sceneInput = { ...object(sceneProperties), anyOf: [{ required: ['template'] }, { required: ['scene'] }] };
function tool(name, description, inputSchema) {
  return { name, description, inputSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } };
}
export const workflowTools = [
  tool('coreldraw_set_units', 'Set the target document units using Corel cdrUnit values. Existing artwork is not rescaled.', object({ unit: { type: 'string', enum: ['mm','cm','inches','points','pixels'] } }, ['unit'])),
  tool('coreldraw_add_dimension', 'Create an editable dimension annotation from three lines and text in document coordinates. It is geometric and non-associative: later object edits do not update it.', object({ x1: coordinate, y1: coordinate, x2: coordinate, y2: coordinate, offset: coordinate, label: shortText, precision: { type: 'integer', minimum: 0, maximum: 6 }, unitSuffix: { type: 'string', maxLength: 30 }, textOffset: coordinate }, ['x1','y1','x2','y2','offset'])),
  tool('coreldraw_set_cut_line', 'Style explicit shape IDs as cut lines with an RGB outline and width in current document units; removes fills by default. This does not configure a cutter or guarantee machine recognition.', object({ shapeIds: { type: 'array', items: id, minItems: 1, maxItems: 500 }, color: hex, width: positive, removeFill: { type: 'boolean' } }, ['shapeIds','color','width'])),
  tool('coreldraw_create_scene', 'Create a named editable landscape/sign template or a reusable JSON scene of rect, ellipse, closed polygon and text elements. Supply exactly one of template or scene. Coordinates use document units; width/height size built-ins only. Groups by default. Returns groupId, namedShapes and textFields manifests; pass textFields to personalize_batch.fields because Mac logical labels may not persist in the CDR file.', sceneInput),
  tool('coreldraw_personalize_batch', 'Duplicate a source group for up to 100 records (at most 10000 copied descendants total) and replace uniquely named text descendants. Use fields (name/shapeId pairs from scene.textFields) when native names are unavailable; every field must be a text descendant. All names and IDs are checked before mutation. Offsets are multiples 1..N from the original in document units. Stops on native failure and reports surviving copies; one undo group, not transactional rollback.', object({ sourceId: id, fields: { type: 'array', minItems: 1, maxItems: 500, items: object({ name: { type: 'string', minLength: 1, maxLength: 1000 }, shapeId: id }, ['name','shapeId']) }, records: { type: 'array', minItems: 1, maxItems: 100, items: object({ name: shortText, replacements: { type: 'array', minItems: 1, maxItems: 100, items: object({ name: { type: 'string', minLength: 1, maxLength: 1000 }, text: { type: 'string', maxLength: 10000 } }, ['name','text']) } }, ['replacements']) }, offsetX: coordinate, offsetY: coordinate }, ['sourceId','records','offsetX','offsetY'])),
  tool('coreldraw_scene_batch', 'Create up to 20 named scenes (at most 500 total elements), preflight every scene, and stop at the first native failure. Returns completed scenes, surviving shape IDs and unattempted count. One central undo group; no automatic rollback.', object({ scenes: { type: 'array', items: sceneInput, minItems: 1, maxItems: 20 } }, ['scenes'])),
];

// This function is serialized, then evaluated inside the central documentScript closure.
// Required helpers: doc/page/layer/args, host.CreateCurve(doc), getShape(id),
// getShapes(ids)->ShapeRange, describeShape(s), describeDocument(doc), color(hex),
// getShapeName(s), setShapeName(s,name). Mac logical labels may be operation-scoped;
// explicit JSON manifests preserve source field identity for later personalization calls.
function workflowRuntime() {
  function num(v, label) { if (typeof v !== 'number' || !isFinite(v)) throw new Error(label + ' must be finite'); return v; }
  function validColor(v) { if (v !== undefined && !/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error('Color must be #RRGGBB'); }
  function applyStyle(s, options) {
    if (options.fill !== undefined) s.Fill.ApplyUniformFill(color(options.fill));
    if (options.outlineWidth !== undefined) s.Outline.Width = options.outlineWidth;
    if (options.outlineColor !== undefined) s.Outline.Color.CopyAssign(color(options.outlineColor));
    if (options.name !== undefined) setShapeName(s, options.name);
    if (options.fontSize !== undefined) s.Text.Story.Size = options.fontSize;
  }
  function line(x1,y1,x2,y2) {
    // Curves work on the Mac JavaScript bridge and remain ordinary editable objects.
    var c = host.CreateCurve(doc), p = c.CreateSubPath(x1,y1); p.AppendLineSegment(x2,y2); return layer.CreateCurve(c);
  }
  function dimension(a) {
    var dx = a.x2-a.x1, dy = a.y2-a.y1, length = Math.sqrt(dx*dx+dy*dy);
    if (!length) throw new Error('Dimension endpoints must be distinct');
    var nx = -dy/length, ny = dx/length, ox = nx*a.offset, oy = ny*a.offset;
    var suffixes = {1:'in',3:'mm',4:'cm',5:'px',14:'pt'};
    var suffix = a.unitSuffix === undefined ? (suffixes[doc.Unit] || '') : a.unitSuffix;
    var label = a.label === undefined ? length.toFixed(a.precision === undefined ? 2 : a.precision) + (suffix ? ' '+suffix : '') : a.label;
    var created = [line(a.x1,a.y1,a.x1+ox,a.y1+oy),line(a.x2,a.y2,a.x2+ox,a.y2+oy),line(a.x1+ox,a.y1+oy,a.x2+ox,a.y2+oy)];
    var textOffset = a.textOffset === undefined ? 2 : a.textOffset;
    created.push(layer.CreateArtisticText((a.x1+a.x2)/2+ox+nx*textOffset,(a.y1+a.y2)/2+oy+ny*textOffset,label));
    return { measurement:length,label:label,associative:false,unit:doc.Unit,shapes:created.map(describeShape) };
  }
  function cutLine(a) {
    var shapes = a.shapeIds.map(getShape); // resolve every ID before the first change
    validColor(a.color);
    shapes.forEach(function(s) { s.Outline.Width = a.width; s.Outline.Color.CopyAssign(color(a.color)); if(a.removeFill !== false) s.Fill.ApplyNoFill(); });
    return { shapes:shapes.map(describeShape),width:a.width,unit:doc.Unit,color:a.color,fillRemoved:a.removeFill !== false };
  }
  function builtIn(a) {
    var w = a.width === undefined ? 200 : a.width, h = a.height === undefined ? 120 : a.height;
    if(a.template === 'sign') return [
      {type:'rect',name:'Sign background',x:0,y:0,width:w,height:h,fill:'#263B35'},
      {type:'rect',name:'Inset panel',x:w*.035,y:h*.06,width:w*.93,height:h*.88,fill:'#E9DFC5'},
      {type:'text',name:'Title',x:w*.10,y:h*.56,text:a.title === undefined ? 'THE WORKSHOP' : a.title,fontSize:28,fill:'#263B35'},
      {type:'text',name:'Subtitle',x:w*.10,y:h*.26,text:a.subtitle === undefined ? 'MADE WITH CARE' : a.subtitle,fontSize:14,fill:'#6D4C35'},
    ];
    if(a.template !== 'landscape') throw new Error('Unknown scene template');
    return [
      {type:'rect',name:'Sky',x:0,y:0,width:w,height:h,fill:'#A5D4E8'},
      {type:'ellipse',name:'Sun',x:w*.73,y:h*.67,width:w*.15,height:w*.15,fill:'#FFE5A0'},
      {type:'polygon',name:'Distant mountains',points:[{x:0,y:h*.30},{x:w*.25,y:h*.82},{x:w*.48,y:h*.34},{x:w*.7,y:h*.72},{x:w,y:h*.25}],fill:'#7E9DA7'},
      {type:'polygon',name:'Near mountains',points:[{x:0,y:h*.22},{x:w*.19,y:h*.60},{x:w*.42,y:h*.23},{x:w*.76,y:h*.57},{x:w,y:h*.20}],fill:'#4B7777'},
      {type:'rect',name:'Meadow',x:0,y:0,width:w,height:h*.25,fill:'#65865B'},
      {type:'polygon',name:'River',points:[{x:w*.37,y:0},{x:w*.67,y:0},{x:w*.56,y:h*.24},{x:w*.50,y:h*.24}],fill:'#7CB8CC'},
      {type:'polygon',name:'Pine left',points:[{x:w*.08,y:h*.17},{x:w*.17,y:h*.54},{x:w*.26,y:h*.17}],fill:'#284C40'},
      {type:'polygon',name:'Pine right',points:[{x:w*.78,y:h*.13},{x:w*.86,y:h*.46},{x:w*.94,y:h*.13}],fill:'#284C40'},
    ];
  }
  function prepare(a) {
    if (!!a.scene === !!a.template) throw new Error('Supply exactly one of template or scene');
    var elements = a.scene ? a.scene.elements : builtIn(a);
    if(!Array.isArray(elements) || elements.length < 1 || elements.length > 200) throw new Error('Scene requires 1..200 elements');
    num(a.x === undefined ? 0 : a.x,'Scene x'); num(a.y === undefined ? 0 : a.y,'Scene y');
    elements.forEach(function(e) {
      if(!e || ['rect','ellipse','polygon','text'].indexOf(e.type) < 0) throw new Error('Unsupported scene element type');
      if(e.name !== undefined && (typeof e.name !== 'string' || e.name.length<1)) throw new Error('Element name label must be nonempty');
      validColor(e.fill); validColor(e.outlineColor);
      if(e.outlineWidth !== undefined && !(num(e.outlineWidth,'Outline width') > 0)) throw new Error('Outline width must be positive');
      if(e.type === 'polygon') {
        if(!Array.isArray(e.points) || e.points.length < 3 || e.points.length > 1000) throw new Error('Polygon requires 3..1000 points');
        e.points.forEach(function(p) {num(p.x,'Point x');num(p.y,'Point y');});
      } else {
        num(e.x,'Element x'); num(e.y,'Element y');
        if(e.type !== 'text') { if(!(num(e.width,'Width') > 0) || !(num(e.height,'Height') > 0)) throw new Error('Dimensions must be positive'); }
        else if(typeof e.text !== 'string') throw new Error('Text must be a string');
      }
    });
    return {options:a,elements:elements};
  }
  function create(prepared, created) {
    var a = prepared.options, x = a.x || 0, y = a.y || 0;
    prepared.elements.forEach(function(e) {
      var s;
      if(e.type === 'rect') s = layer.CreateRectangle2(x+e.x,y+e.y,e.width,e.height);
      else if(e.type === 'ellipse') s = layer.CreateEllipse(x+e.x,y+e.y+e.height,x+e.x+e.width,y+e.y);
      else if(e.type === 'text') s = layer.CreateArtisticText(x+e.x,y+e.y,e.text);
      else {
        var c=host.CreateCurve(doc), p=c.CreateSubPath(x+e.points[0].x,y+e.points[0].y);
        for(var i=1;i<e.points.length;i++) p.AppendLineSegment(x+e.points[i].x,y+e.points[i].y);
        p.Closed=true; s=layer.CreateCurve(c);
      }
      created.push(s); // retain evidence even if styling fails
      applyStyle(s,e);
    });
    var group = null;
    if(a.group !== false) { var range=getShapes(created.map(function(s){return s.StaticID;})); group=range.Group(); created.group=group; if(a.name !== undefined) setShapeName(group,a.name); }
    var namedShapes=[],textFields=[];
    prepared.elements.forEach(function(e,i){if(e.name !== undefined){var entry={name:e.name,shapeId:created[i].StaticID};namedShapes.push(entry);if(e.type==='text')textFields.push(entry);}});
    return {name:a.name || null,template:a.template || 'custom',shapes:created.map(describeShape),group:group ? describeShape(group) : null,groupId:group ? group.StaticID : null,namedShapes:namedShapes,textFields:textFields};
  }
  function sceneBatch(items) {
    var prepared=items.map(prepare), total=0; prepared.forEach(function(p){total+=p.elements.length;});
    if(items.length > 20 || total > 500) throw new Error('Scene batch exceeds 20 scenes or 500 elements');
    var completed=[];
    for(var i=0;i<prepared.length;i++) {
      var created=[];
      try {completed.push(create(prepared[i],created));}
      catch(e) {return {status:completed.length || created.length ? 'partial' : 'failed',partial:true,failedIndex:i,error:String(e && e.message || e),completed:completed,failed:{index:i,error:String(e && e.message || e),createdShapeIds:created.map(function(s){return s.StaticID;}).concat(created.group ? [created.group.StaticID] : [])},notAttempted:prepared.length-i-1};}
    }
    return {status:'complete',partial:false,completed:completed,failed:null,notAttempted:0};
  }
  function namedDescendants(group) {
    var map=Object.create(null), visited=Object.create(null), count=0,entries=[],byId=Object.create(null),byPath=Object.create(null);
    function walk(parent,depth,path) {
      if(depth>30) throw new Error('Source group nesting exceeds 30 levels');
      if(!parent.Shapes) return;
      for(var i=1;i<=parent.Shapes.Count;i++) {
        var s=parent.Shapes.Item(i), key=String(s.StaticID);
        if(visited[key]) continue; visited[key]=true;
        if(++count>10000) throw new Error('Source group exceeds 10000 descendants');
        var childPath=path.concat([i]),entry={shape:s,path:childPath,type:s.Type,childCount:s.Type===7 && s.Shapes ? s.Shapes.Count : 0};
        entries.push(entry);byId[key]=entry;byPath[childPath.join('/')]=entry;
        var name=getShapeName(s); if(name) {name=String(name); if(!Object.prototype.hasOwnProperty.call(map,name)) map[name]=[]; map[name].push(s);}
        if(s.Type===7) walk(s,depth+1,childPath);
      }
    }
    walk(group,0,[]); return {names:map,count:count,entries:entries,byId:byId,byPath:byPath,rootCount:group.Shapes.Count};
  }
  function checkNames(names,records) {
    records.forEach(function(record) {
      var seen=Object.create(null);
      record.replacements.forEach(function(r) {
        if(Object.prototype.hasOwnProperty.call(seen,r.name)) throw new Error('Repeated replacement name: '+r.name); seen[r.name]=true;
        if(!Object.prototype.hasOwnProperty.call(names,r.name)) throw new Error('Unknown descendant name: '+r.name);
        if(names[r.name].length !== 1) throw new Error('Ambiguous descendant name: '+r.name);
        var s=names[r.name][0];
        if(s.Type!==6 || !s.Text || !s.Text.Story) throw new Error('Named descendant is not text: '+r.name);
      });
    });
  }
  function fieldManifest(a,sourceInfo) {
    var fields=[],seenNames=Object.create(null),seenIds=Object.create(null);
    if(a.fields !== undefined) {
      if(!Array.isArray(a.fields) || a.fields.length<1 || a.fields.length>500) throw new Error('Fields requires 1..500 entries');
      a.fields.forEach(function(f){
        if(Object.prototype.hasOwnProperty.call(seenNames,f.name)) throw new Error('Duplicate field name: '+f.name);
        if(Object.prototype.hasOwnProperty.call(seenIds,String(f.shapeId))) throw new Error('Duplicate field shapeId: '+f.shapeId);
        var entry=sourceInfo.byId[String(f.shapeId)];
        if(!entry) throw new Error('Field shape is not a source descendant: '+f.shapeId);
        if(entry.type!==6 || !entry.shape.Text || !entry.shape.Text.Story) throw new Error('Field descendant is not text: '+f.name);
        seenNames[f.name]=true;seenIds[String(f.shapeId)]=true;fields.push({name:f.name,shapeId:f.shapeId,path:entry.path});
      });
      var selected=Object.create(null);fields.forEach(function(f){selected[f.name]=[sourceInfo.byId[String(f.shapeId)].shape];});
      checkNames(selected,a.records);
    } else {
      checkNames(sourceInfo.names,a.records);
      a.records.forEach(function(r){r.replacements.forEach(function(v){if(!Object.prototype.hasOwnProperty.call(seenNames,v.name)){seenNames[v.name]=true;var shape=sourceInfo.names[v.name][0];fields.push({name:v.name,shapeId:shape.StaticID,path:sourceInfo.byId[String(shape.StaticID)].path});}});});
    }
    return fields;
  }
  function copyFieldTargets(sourceInfo,copyInfo,fields,explicit) {
    if(explicit) {
      if(sourceInfo.rootCount!==copyInfo.rootCount || sourceInfo.entries.length!==copyInfo.entries.length) throw new Error('Duplicate structure does not match source');
      sourceInfo.entries.forEach(function(entry){var other=copyInfo.byPath[entry.path.join('/')];if(!other || other.type!==entry.type || other.childCount!==entry.childCount)throw new Error('Duplicate structure/type does not match source at '+entry.path.join('/'));});
    }
    var targets=Object.create(null);
    fields.forEach(function(f){
      if(explicit) targets[f.name]=[copyInfo.byPath[f.path.join('/')].shape];
      else targets[f.name]=copyInfo.names[f.name] || [];
    });
    return targets;
  }
  function personalize(a) {
    var source=getShape(a.sourceId);
    if(source.Type!==7 || !source.Shapes) throw new Error('Personalization source must be a group');
    if(a.records.length<1 || a.records.length>100) throw new Error('Personalization requires 1..100 records');
    if(Math.abs(a.offsetX*a.records.length)>1000000 || Math.abs(a.offsetY*a.records.length)>1000000) throw new Error('Final duplicate offset exceeds coordinate bounds');
    var sourceInfo=namedDescendants(source);
    if(sourceInfo.count*a.records.length>10000) throw new Error('Personalization exceeds 10000 copied descendants');
    var fields=fieldManifest(a,sourceInfo),sourceFields=fields.map(function(f){return {name:f.name,shapeId:f.shapeId};});
    var completed=[];
    for(var i=0;i<a.records.length;i++) {
      var duplicate=null;
      try {
        duplicate=source.Duplicate(a.offsetX*(i+1),a.offsetY*(i+1));
        var copyInfo=namedDescendants(duplicate),targets=copyFieldTargets(sourceInfo,copyInfo,fields,a.fields !== undefined); checkNames(targets,[a.records[i]]);
        a.records[i].replacements.forEach(function(r){targets[r.name][0].Text.Story.Text=r.text;});
        if(a.records[i].name !== undefined) setShapeName(duplicate,a.records[i].name);
        var copiedFields=fields.map(function(f){return {name:f.name,shapeId:targets[f.name][0].StaticID};});
        completed.push({index:i,shape:describeShape(duplicate),groupId:duplicate.StaticID,namedShapes:copiedFields,textFields:copiedFields});
      } catch(e) {return {sourceId:a.sourceId,fields:sourceFields,status:completed.length || duplicate ? 'partial':'failed',partial:true,failedIndex:i,error:String(e && e.message || e),completed:completed,failed:{index:i,error:String(e && e.message || e),createdShapeIds:duplicate ? [duplicate.StaticID]:[]},notAttempted:a.records.length-i-1};}
    }
    return {sourceId:a.sourceId,fields:sourceFields,status:'complete',partial:false,completed:completed,failed:null,notAttempted:0};
  }
  return {dimension:dimension,cutLine:cutLine,sceneBatch:sceneBatch,personalize:personalize};
}
const runtime = `var workflow = (${workflowRuntime.toString()})();\n`;
export function buildWorkflowOperation(name, args) {
  if(name === 'coreldraw_set_units') {
    return {body:'var units={mm:3,cm:4,inches:1,points:14,pixels:5}; if(!Object.prototype.hasOwnProperty.call(units,args.unit)) throw new Error("Unknown unit"); doc.Unit=units[args.unit]; return {unit:args.unit,value:doc.Unit,document:describeDocument(doc)};',mutates:true,label:'Set document units'};
  }
  const expressions = {
    coreldraw_add_dimension: ['workflow.dimension(args)','Add dimension annotation'],
    coreldraw_set_cut_line: ['workflow.cutLine(args)','Style cut lines'],
    coreldraw_create_scene: ['workflow.sceneBatch([args])','Create editable scene'],
    coreldraw_personalize_batch: ['workflow.personalize(args)','Personalize group batch'],
    coreldraw_scene_batch: ['workflow.sceneBatch(args.scenes)','Create editable scene batch'],
  };
  const entry=expressions[name];
  if(!entry) return null;
  // Single-scene results keep the familiar scene object while retaining partial-failure evidence.
  const body = name === 'coreldraw_create_scene' ? runtime+'var result=workflow.sceneBatch([args]); return result.status === "complete" ? result.completed[0] : result;' : runtime+'return '+entry[0]+';';
  return {body,mutates:true,label:entry[1]};
}
