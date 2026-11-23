// Native workflow/file acceptance. Creates a new disposable document and new output directory.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { CorelBridge } from '../src/bridge.mjs';
import { buildOperation } from '../src/tools.mjs';
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const output=fileURLToPath(new URL('../artifacts/workflows-'+stamp+'/',import.meta.url));
await mkdir(output,{recursive:true});
const evidence=[],bridge=new CorelBridge({timeoutSeconds:45});let document;
async function call(name,args={}){
  const input={...(document&&name!=='coreldraw_create_document'?{document}:{}),...args};
  try{const op=await buildOperation(name,input),result=await bridge.run(op.code,op);evidence.push({name,args:input,result});await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2));if(result?.partial)throw new Error('Partial native result');process.stdout.write(name+' OK\n');return result;}
  catch(e){evidence.push({name,args:input,error:e.message});await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2));throw e;}
}
try{
  document=(await call('coreldraw_create_document',{name:'MCP workflows '+stamp,width:240,height:160})).document.id;
  const sign=await call('coreldraw_create_scene',{template:'sign',name:'Personalization source',title:'SOURCE',width:70,height:40,x:0,y:100});
  await call('coreldraw_personalize_batch',{sourceId:sign.group.shapeId,fields:sign.textFields,records:[{name:'First',replacements:[{name:'Title',text:'ALPHA'}]},{name:'Second',replacements:[{name:'Title',text:'BETA'}]}],offsetX:75,offsetY:0});
  await call('coreldraw_scene_batch',{scenes:[{template:'landscape',x:10,y:15,width:100,height:60},{scene:{elements:[{type:'text',x:120,y:65,text:'Editable vector landscape',fontSize:10}]},group:false}]});
  const cut=await call('coreldraw_create_polygon',{name:'Cut triangle',points:[{x:140,y:20},{x:170,y:20},{x:155,y:45}]});
  await call('coreldraw_set_cut_line',{shapeIds:[cut.shapeId],color:'#FF00FF',width:.1});
  await call('coreldraw_add_dimension',{x1:140,y1:20,x2:170,y2:20,offset:-6,precision:1});
  const objects=await call('coreldraw_list_objects',{recursive:true,limit:1000});assert.ok(objects.objects.length>20);
  await call('coreldraw_create_document',{name:'MCP workflow decoy '+stamp,width:10,height:10});
  const preview=await call('coreldraw_preview',{path:join(output,'preview.png'),width:1200,height:800,dpi:144});assert.equal(preview.pixelWidth,1200);assert.equal(preview.pixelHeight,800);
  await call('coreldraw_export_file',{path:join(output,'drawing.svg'),format:'svg'});
  await call('coreldraw_export_file',{path:join(output,'drawing.pdf'),format:'pdf'});
  const imported=await call('coreldraw_import_file',{path:join(output,'preview.png')});assert.ok(imported.importedCount>0);
  await call('coreldraw_create_document',{name:'MCP save decoy '+stamp,width:10,height:10});
  const saved=await call('coreldraw_save_as',{path:join(output,'drawing.cdr')});assert.equal(saved.sourceDocument.id,document);assert.ok(saved.shapeCountAfter>8);document=saved.document.id;
  await call('coreldraw_inspect_document');
  process.stdout.write('Artifacts: '+output+'\n');
}catch(e){process.stderr.write(e.message+'\nEvidence: '+output+'\n');process.exitCode=1;}
