const index = { type: 'integer', minimum: 1, maximum: 2147483647 };
const size = { type: 'number', exclusiveMinimum: 0, maximum: 1e6 };
const name = { type: 'string', minLength: 1, maxLength: 255 };
const boolean = { type: 'boolean' };
const tool = (suffix, description, properties = {}, required = [], readOnly = false) => ({
  name: `coreldraw_${suffix}`, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false },
});

export const pageTools = [
  tool('list_pages', 'List target-document pages in batches of up to 100, dimensions in document units and the active page index. Omitted offset/limit use 0/100. Continue using nextOffset until null. Native names beyond 255 characters are clipped with nameTruncated.', { offset: { type: 'integer', minimum: 0, maximum: 2147483647 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, [], true),
  tool('add_pages', 'Append 1–100 blank pages to the target document. Omitted count adds one. Verifies the resulting page count.', { count: { type: 'integer', minimum: 1, maximum: 100 } }),
  tool('activate_page', 'Activate a target-document page by its one-based index and verify the active page.', { index }, ['index']),
  tool('set_page_size', 'Set page width and height in document units, then verify both dimensions. Omit index for the active page.', { index, width: size, height: size }, ['width', 'height']),
  tool('rename_page', 'Rename a page and verify its native name. Omit index for the active page.', { index, name }, ['name']),
  tool('activate_layer', 'Activate the uniquely matching exact layer name on the target active page. Missing or ambiguous names fail before activation.', { name }, ['name']),
  tool('set_layer_properties', 'Set visibility, editability or printing on a uniquely named target active-page layer. Requires at least one flag and verifies native readback.', { name, visible: boolean, editable: boolean, printable: boolean }, ['name']),
];

const helpers = `
function pageIndex(p){
  var value=p?Number(p.Index):NaN;
  return isFinite(value)&&Math.floor(value)===value&&value>=1?value:null;
}
function describePage(p,i){var name=String(p.Name||'');return {index:i===undefined?pageIndex(p):i,name:name.slice(0,255),nameTruncated:name.length>255,width:p.SizeWidth,height:p.SizeHeight,layerCount:p.Layers?p.Layers.Count:null,shapeCount:p.Shapes?p.Shapes.Count:null};}
function targetPage(){
  if(args.index===undefined){if(!page)throw new Error('Active page unavailable');return page;}
  if(args.index<1||Math.floor(args.index)!==args.index||args.index>doc.Pages.Count)throw new Error('Page index not found: '+args.index);
  var found=doc.Pages.Item(args.index);if(!found)throw new Error('Page index not found: '+args.index);return found;
}
function layerFlag(l,key){
  var value=l[key];
  if(value===true||value===1||value===-1)return true;
  if(value===false||value===0)return false;
  return null;
}
function describeLayer(l,i){var name=String(l.Name||'');return {index:i,name:name.slice(0,255),nameTruncated:name.length>255,visible:layerFlag(l,'Visible'),editable:layerFlag(l,'Editable'),printable:layerFlag(l,'Printable'),shapeCount:l.Shapes?l.Shapes.Count:null};}
function targetLayer(){
  if(!page||!page.Layers)throw new Error('Active page layers unavailable');
  if(page.Layers.Count>1000)throw new Error('Layer count exceeds 1000; exact-name resolution refused');
  var found=null,foundIndex=null;
  for(var i=1;i<=page.Layers.Count;i++){
    var candidate=page.Layers.Item(i);
    if(String(candidate.Name||'')===args.name){if(found)throw new Error('Layer name is ambiguous: '+args.name);found=candidate;foundIndex=i;}
  }
  if(!found)throw new Error('Layer not found: '+args.name);
  return {layer:found,index:foundIndex};
}
`;

const bodies = {
  list_pages: `
var count=doc.Pages.Count,pages=[],offset=args.offset===undefined?0:args.offset,limit=args.limit===undefined?100:args.limit,end=Math.min(count,offset+limit);
for(var i=offset+1;i<=end;i++)pages.push(describePage(doc.Pages.Item(i),i));
var truncated=end<count;
return {pageCount:count,activePageIndex:pageIndex(page),offset:offset,limit:limit,pages:pages,truncated:truncated,nextOffset:truncated?end:null};`,
  add_pages: `
var count=args.count===undefined?1:args.count,before=doc.Pages.Count;
doc.AddPages(count);
if(doc.Pages.Count!==before+count)throw new Error('Added page count verification failed: expected '+(before+count)+', observed '+doc.Pages.Count);
return {pageCount:doc.Pages.Count,added:count};`,
  activate_page: `
var target=targetPage();target.Activate();
if(pageIndex(doc.ActivePage)!==args.index)throw new Error('Page activation verification failed for index '+args.index);
return describePage(doc.ActivePage,args.index);`,
  set_page_size: `
var target=targetPage();target.SetSize(args.width,args.height);
var width=Number(target.SizeWidth),height=Number(target.SizeHeight);
if(!isFinite(width)||!isFinite(height)||Math.abs(width-args.width)>1e-6||Math.abs(height-args.height)>1e-6)throw new Error('Page size verification failed; requested dimensions were not retained');
return describePage(target,args.index);`,
  rename_page: `
var target=targetPage();target.Name=args.name;
if(String(target.Name||'')!==args.name)throw new Error('Page name verification failed; requested name was not retained');
return describePage(target,args.index);`,
  activate_layer: `
var resolved=targetLayer();resolved.layer.Activate();
if(!doc.ActiveLayer||String(doc.ActiveLayer.Name||'')!==args.name)throw new Error('Layer activation verification failed for '+args.name);
return describeLayer(doc.ActiveLayer,resolved.index);`,
  set_layer_properties: `
if(args.visible===undefined&&args.editable===undefined&&args.printable===undefined)throw new Error('At least one layer property is required');
var resolved=targetLayer(),target=resolved.layer,properties=[['visible','Visible'],['editable','Editable'],['printable','Printable']];
for(var i=0;i<properties.length;i++){
  var property=properties[i];
  if(args[property[0]]!==undefined&&layerFlag(target,property[1])===null)throw new Error(property[0]+' property unavailable; no layer property edit dispatched');
}
for(var i=0;i<properties.length;i++){
  var property=properties[i];
  if(args[property[0]]!==undefined){
    target[property[1]]=args[property[0]];
    if(layerFlag(target,property[1])!==args[property[0]])throw new Error(property[0]+' property verification failed; requested value was not retained');
  }
}
return describeLayer(target,resolved.index);`,
};

export function buildPageOperation(name, args = {}) {
  const suffix = name.replace(/^coreldraw_/, '');
  if (!name.startsWith('coreldraw_') || !Object.hasOwn(bodies, suffix)) return null;
  return { body: helpers + bodies[suffix], mutates: suffix !== 'list_pages', label: `MCP ${suffix.replaceAll('_', ' ')}` };
}
