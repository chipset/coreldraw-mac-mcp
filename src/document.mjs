export const documentProperty = { type: 'string', minLength: 1, maxLength: 4096, description: 'Document id returned by list_documents (path:... or name:...). Required for edits when multiple documents are open.' };
export const documentTools = [{name:'coreldraw_list_documents',description:'List bounded document identities. Saved ids use full paths; unsaved ids use unique names. Ids change after Save As or renaming; duplicate names require saving/renaming before targeting.',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}];

export const json = value => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export const documentRuntime = `
var logicalShapeNames={};
function getShapeName(s){return Object.prototype.hasOwnProperty.call(logicalShapeNames,s.StaticID)?logicalShapeNames[s.StaticID]:String(s.Name||'');}
function setShapeName(s,name){
  try{s.Name=name;}catch(e){}
  if(String(s.Name||'')!==name)logicalShapeNames[s.StaticID]=name;
  else delete logicalShapeNames[s.StaticID];
}
function collectionItem(c,i){return c.Item(i);}
function describeDocument(d){
  var p=d.ActivePage, full=String(d.FullFileName||''), name=String(d.Name||'');
  return {id:full?'path:'+full:'name:'+name,name:name,fileName:String(d.FileName||''),fullFileName:full,
    unit:d.Unit,pageCount:d.Pages?d.Pages.Count:0,activePage:p?{name:String(p.Name||''),width:p.SizeWidth,height:p.SizeHeight,shapeCount:p.Shapes.Count}:null,
    selectionCount:d.Selection().Shapes.Count};
}
function resolveDocument(selector,mutates){
  var count=host.Documents.Count;
  if(count<1)throw new Error('No CorelDRAW document is open');
  if(!selector){if(mutates&&count>1)throw new Error('Explicit document is required when multiple documents are open');return host.ActiveDocument;}
  var found=[], path=selector.indexOf('path:')===0?selector.slice(5):selector.charAt(0)==='/'?selector:null;
  var name=selector.indexOf('name:')===0?selector.slice(5):selector;
  for(var i=1;i<=count;i++){var d=collectionItem(host.Documents,i);if(path?String(d.FullFileName||'')===path:String(d.Name||'')===name)found.push(d);}
  if(found.length===0)throw new Error('Document not found: '+selector);
  if(found.length!==1)throw new Error('Document selector is ambiguous: '+selector);
  return found[0];
}
function describeShape(s){
  var out={shapeId:s.StaticID,type:s.Type,name:getShapeName(s),layer:s.Layer?String(s.Layer.Name||''):'',x:s.LeftX,y:s.BottomY,width:s.SizeWidth,height:s.SizeHeight};
  if(Object.prototype.hasOwnProperty.call(logicalShapeNames,s.StaticID)){out.namePersistence='manifest';out.nativeName=String(s.Name||'');}
  try{if(s.Fill){out.fill={type:s.Fill.Type};if(s.Fill.Type===1)out.fill.color=String(s.Fill.UniformColor.HexValue);}}catch(e){out.fill={unavailable:true};}
  try{if(s.Outline)out.outline={width:s.Outline.Width,color:String(s.Outline.Color.HexValue)};}catch(e){out.outline={unavailable:true};}
  try{if(s.Type===6&&s.Text&&s.Text.Story){var t=s.Text.Story,text=String(t.Text);out.text={text:text.slice(0,500),truncated:text.length>500,font:String(t.Font),size:t.Size,bold:!!t.Bold,italic:!!t.Italic,alignment:t.Alignment};}}catch(e){out.text={unavailable:true};}
  return out;
}
function color(hex){return host.CreateRGBColor(parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16));}
`;

export function documentScript(args, body, { mutates = false, label = 'CorelDRAW MCP' } = {}) {
  return `${documentRuntime}
var args=${json(args)};
var doc=resolveDocument(args.document,${mutates});
${mutates ? `doc.Activate();
if(String(host.ActiveDocument.FullFileName||'')!==String(doc.FullFileName||'')||String(host.ActiveDocument.Name)!==String(doc.Name))throw new Error('Document activation mismatch; no edit dispatched');` : ''}
var page=doc.ActivePage,layer=doc.ActiveLayer;
function getShape(id){
  var visited=0;
  function find(shapes,depth){
    if(depth>30)throw new Error('Shape nesting exceeds safety bound');
    for(var i=1;i<=shapes.Count;i++){
      if(++visited>10000)throw new Error('Shape search exceeds 10000 objects');
      var s=collectionItem(shapes,i);if(s.StaticID===id)return s;
      if(s.Type===7&&s.Shapes&&s.Shapes.Count){var result=find(s.Shapes,depth+1);if(result)return result;}
    }return null;
  }
  var result=find(page.Shapes,0);if(!result)throw new Error('Shape '+id+' not found on target page');return result;
}
function getShapes(ids){
  var resolved=[],seen={};for(var i=0;i<ids.length;i++){if(seen[ids[i]])throw new Error('Duplicate shape id');seen[ids[i]]=true;resolved.push(getShape(ids[i]));}
  var range=host.CreateShapeRange();for(var j=0;j<resolved.length;j++)range.Add(resolved[j]);return range;
}
${mutates ? `doc.BeginCommandGroup(${json(label)});
try{return (function(){${body}\n})();}
catch(error){throw new Error(String(error.message||error)+'; edits may be partial. Use Undo for the '+${json(label)}+' command group.');}
finally{doc.EndCommandGroup();}` : body}`;
}
