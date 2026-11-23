// Explicit opt-in native acceptance. Creates a disposable drawing and new artifacts.
// Never edits an existing document. Run: node examples/accept-expansion.mjs
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { CorelBridge } from '../src/bridge.mjs';
import { buildOperation } from '../src/tools.mjs';
const resume=process.argv[2];
const previous=resume?JSON.parse(await readFile(join(resume,'evidence.json'),'utf8')):[];
if(resume && !/Script was not run/.test(previous.at(-1)?.error||''))throw new Error('Resume is permitted only after an explicit pre-activation no-execution failure');
const cached=previous.filter(item=>!item.error);
const stamp=resume?cached[0].args.name.slice('MCP acceptance '.length):new Date().toISOString().replace(/[:.]/g,'-');
const output=resume||fileURLToPath(new URL('../artifacts/acceptance-'+stamp+'/',import.meta.url));
await mkdir(output,{recursive:true});
const evidence=[],bridge=new CorelBridge({timeoutSeconds:45});
let document;
async function call(name,args={}) {
  const input={...(document && name!=='coreldraw_create_document'&&name!=='coreldraw_list_documents'?{document}:{}),...args};
  if(evidence.length<cached.length){const saved=cached[evidence.length];assert.equal(saved.name,name);assert.deepEqual(saved.args,input);evidence.push(saved);return saved.result;}
  try {
    const operation=await buildOperation(name,input);
    const result=operation.status?await bridge.status():await bridge.run(operation.code,operation);
    evidence.push({name,args:input,result});
    await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2));
    if(result?.partial||result?.status==='failed')throw new Error('Native partial result: '+JSON.stringify(result));
    process.stdout.write(name+' OK\n');return result;
  } catch(error) {
    evidence.push({name,args:input,error:error.message});
    await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2));
    process.stderr.write(name+' FAILED '+error.message+'\n');throw error;
  }
}
try {
  const created=await call('coreldraw_create_document',{name:'MCP acceptance '+stamp,width:240,height:160});
  document=created.document.id;
  await call('coreldraw_list_documents');
  await call('coreldraw_inspect_document');
  await call('coreldraw_set_units',{unit:'mm'});
  await call('coreldraw_list_layers');
  await call('coreldraw_create_layer',{name:'MCP acceptance',activate:true});
  const rect=await call('coreldraw_create_rectangle',{x:10,y:10,width:30,height:20});
  const ellipse=await call('coreldraw_create_ellipse',{x:30,y:15,width:20,height:20});
  const text=await call('coreldraw_create_text',{x:15,y:55,text:'MCP acceptance'});
  await call('coreldraw_style_text',{ids:[text.shapeId],font:'Arial',size:16,bold:true,italic:false,align:'center'});
  const polygon=await call('coreldraw_create_polygon',{name:'Triangle',points:[{x:70,y:10},{x:90,y:10},{x:80,y:35}]});
  const path=await call('coreldraw_create_path',{subpaths:[{start:{x:100,y:10},segments:[{type:'line',x:120,y:10},{type:'cubic',x:110,y:35,c1:{x:130,y:20},c2:{x:110,y:30}}],closed:true}]});
  await call('coreldraw_style_objects',{ids:[rect.shapeId,ellipse.shapeId],fill:{start:'#FFAA22',end:'#2266CC',angle:45},outline:{width:.2,color:'#000000'},transparency:10});
  await call('coreldraw_style_objects',{ids:[polygon.shapeId],fill:'#447744',outline:{color:'none'}});
  await call('coreldraw_transform_objects',{ids:[polygon.shapeId],width:18,height:22,rotation:10,x:70,y:10});
  await call('coreldraw_arrange_objects',{ids:[rect.shapeId,polygon.shapeId,path.shapeId],mode:'bottom'});
  await call('coreldraw_arrange_objects',{ids:[rect.shapeId,polygon.shapeId,path.shapeId],mode:'distribute_x'});
  await call('coreldraw_select_objects',{ids:[polygon.shapeId,path.shapeId]});
  await call('coreldraw_order_objects',{ids:[polygon.shapeId,path.shapeId],position:'front'});
  const group=await call('coreldraw_group_objects',{ids:[polygon.shapeId,path.shapeId],action:'group'});
  await call('coreldraw_group_objects',{ids:[group.shapeId],action:'ungroup'});
  await call('coreldraw_combine_shapes',{ids:[rect.shapeId,ellipse.shapeId],operation:'weld',keepOriginals:true});
  await call('coreldraw_combine_shapes',{ids:[rect.shapeId,ellipse.shapeId],operation:'trim',keepOriginals:true});
  await call('coreldraw_combine_shapes',{ids:[rect.shapeId,ellipse.shapeId],operation:'intersect',keepOriginals:true});
  await call('coreldraw_contour',{ids:[rect.shapeId],direction:'outside',offset:1,steps:2});
  await call('coreldraw_set_cut_line',{shapeIds:[polygon.shapeId],color:'#FF00FF',width:.1});
  await call('coreldraw_add_dimension',{x1:10,y1:10,x2:40,y2:10,offset:-6,precision:1});
  const sign=await call('coreldraw_create_scene',{template:'sign',name:'Personalization source',title:'SOURCE',x:0,y:80,width:70,height:40});
  await call('coreldraw_personalize_batch',{sourceId:sign.group.shapeId,fields:sign.textFields,records:[{name:'First',replacements:[{name:'Title',text:'ALPHA'}]},{name:'Second',replacements:[{name:'Title',text:'BETA'}]}],offsetX:75,offsetY:0});
  await call('coreldraw_scene_batch',{scenes:[{template:'landscape',x:140,y:10,width:80,height:50},{scene:{elements:[{type:'text',x:140,y:65,text:'Editable vector landscape',fontSize:9}]},group:false}]});
  const objects=await call('coreldraw_list_objects',{recursive:true,limit:1000});assert.ok(objects.objects.length>20);assert.equal(objects.truncated,false);
  for(const expected of ['SOURCE','ALPHA','BETA','30.0 mm','Editable vector landscape']){
    assert.ok(objects.objects.some(object=>object.text?.text===expected),'Native text readback missing: '+expected);
  }
  // Move native focus away deliberately. Subsequent exports and save must still
  // use the explicit populated target, rather than this empty drawing.
  await call('coreldraw_create_document',{name:'MCP decoy '+stamp,width:10,height:10});
  const png=await call('coreldraw_preview',{path:join(output,'preview.png'),width:1200,height:800,dpi:144});
  assert.equal(png.pixelWidth,1200);assert.equal(png.pixelHeight,800);
  await call('coreldraw_export_file',{path:join(output,'drawing.svg'),format:'svg'});
  await call('coreldraw_export_file',{path:join(output,'drawing.pdf'),format:'pdf'});
  await call('coreldraw_import_file',{path:join(output,'preview.png')});
  const saved=await call('coreldraw_save_as',{path:join(output,'drawing.cdr')});
  document=saved.document.id;
  await call('coreldraw_inspect_document');
  process.stdout.write('Artifacts: '+output+'\n');
} catch(error) {process.exitCode=1;process.stderr.write('Evidence: '+output+'\n');}
