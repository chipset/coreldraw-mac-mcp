// Opt-in real stdio MCP acceptance. Creates a unique disposable document and
// new output directory. Never retries native mutations or edits existing artwork.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const stamp = new Date().toISOString().replace(/[:.]/g,'-');
const priorPath = process.argv[2] === '--continue-after-verified-delete' ? process.argv[3] : null;
const prior = priorPath ? {
  target: JSON.parse(await readFile(join(priorPath,'target.json'),'utf8')),
  evidence: JSON.parse(await readFile(join(priorPath,'evidence.json'),'utf8')),
  postflight: JSON.parse(await readFile(join(priorPath,'deletion-postflight.json'),'utf8')),
} : null;
if(prior){
  assert.equal(prior.evidence.at(-1).name,'coreldraw_delete_objects');
  assert.equal(prior.evidence.at(-1).isError,true);
  assert.match(prior.evidence.at(-1).result,/referenced object no longer exists/);
  assert.equal(prior.postflight.deletionConfirmed,true);
  assert.equal(prior.postflight.deletedId,prior.evidence.at(-1).args.ids[0]);
  assert.match(prior.target.document,/^name:MCP consolidation /);
}
const output = fileURLToPath(new URL('../artifacts/consolidation-'+stamp+'/',import.meta.url));
await mkdir(output,{recursive:true});
const evidence=[], pending=new Map();
const child=spawn(process.execPath,[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],{
  env:{...process.env,CORELDRAW_TIMEOUT_SECONDS:'45'},stdio:['pipe','pipe','inherit']
});
const lines=createInterface({input:child.stdout});
let sequence=0, document;
lines.on('line',line=>{
  const message=JSON.parse(line),receiver=pending.get(message.id);
  if(!receiver)return;pending.delete(message.id);clearTimeout(receiver.timer);
  message.error?receiver.reject(new Error(message.error.message)):receiver.resolve(message.result);
});
child.on('exit',code=>{for(const receiver of pending.values()){clearTimeout(receiver.timer);receiver.reject(new Error('Server exited '+code));}});
function request(method,params={}){
  return new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>reject(new Error('MCP deadline exceeded; inspect native state before retrying')),60000);
    pending.set(id,{resolve,reject,timer});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
}
async function call(suffix,args={},expectedError=false){
  const name='coreldraw_'+suffix;
  const scoped={...(document&&!['create_document','list_documents','status','run_javascript'].includes(suffix)?{document}:{}),...args};
  const record={name,args:scoped};evidence.push(record);
  await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2));
  const response=await request('tools/call',{name,arguments:scoped});
  const text=response.content.find(item=>item.type==='text')?.text;
  let result;try{result=JSON.parse(text);}catch{result=text;}
  Object.assign(record,{isError:response.isError===true,result,image:response.content.some(item=>item.type==='image'),expectedError});
  await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2));
  assert.equal(record.isError,expectedError, name+': '+JSON.stringify(result));
  console.log(name+(expectedError?' EXPECTED REFUSAL':' OK'));
  return result;
}
try{
  const init=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'consolidation-acceptance',version:'1'}});
  assert.equal(init.serverInfo.version,'0.3.0');
  const catalog=await request('tools/list');assert.equal(catalog.tools.length,47);
  await writeFile(join(output,'tool-catalog.json'),JSON.stringify(catalog.tools,null,2));
  const reference=await request('resources/read',{uri:'coreldraw://reference'});assert.match(reference.contents[0].text,/StaticID/);
  const before=prior?prior.target.before:await call('list_documents');
  if(prior)document=prior.target.document;
  else{const created=await call('create_document',{name:'MCP consolidation '+stamp,width:180,height:120});document=created.document.id;}
  await writeFile(join(output,'target.json'),JSON.stringify({document,output,before},null,2));
  let rect;
  if(prior){
    // Explicit continuation only after terminal failure and separate read-only
    // postflight proved deletion completed. The failed deletion is never replayed.
    const inventory=await call('list_objects',{recursive:true});
    assert.ok(!inventory.objects.some(s=>s.shapeId===prior.postflight.deletedId));
    rect=prior.evidence.find(e=>e.name==='coreldraw_create_rectangle').result;
    assert.ok(inventory.objects.some(s=>s.shapeId===rect.shapeId));
    const text=prior.evidence.find(e=>e.name==='coreldraw_create_text').result;
    const pages=await call('list_pages',{offset:1,limit:1});assert.equal(pages.pages[0].index,2);assert.equal(pages.nextOffset,null);
    await call('set_text',{ids:[text.shapeId],text:'Verified Swift bridge'});
    const verified=await call('get_text',{id:text.shapeId,limit:30000});assert.equal(verified.text,'Verified Swift bridge');
    const copies=await call('duplicate_objects',{ids:[rect.shapeId],dx:0,dy:30,copies:1});
    const copyId=copies.copies[0].shape.shapeId;
    const deletion=await call('delete_objects',{ids:[copyId]});assert.deepEqual(deletion.completed,[copyId]);assert.equal(deletion.partial,false);
  }else{
  await call('list_pages');
  const added=await call('add_pages',{count:1});assert.equal(added.pageCount,2);
  await call('rename_page',{index:2,name:'Migration page'});
  const sized=await call('set_page_size',{index:2,width:200,height:140});assert.ok(Math.abs(sized.width-200)<1e-6);
  const active=await call('activate_page',{index:2});assert.equal(active.index,2);
  await call('activate_page',{index:1});
  await call('create_layer',{name:'Migration artwork',activate:true});
  await call('activate_layer',{name:'Migration artwork'});
  await call('set_layer_properties',{name:'Migration artwork',visible:true,editable:true,printable:false});
  await call('set_layer_properties',{name:'Migration artwork',printable:true});
  rect=await call('create_rectangle',{x:10,y:10,width:30,height:20});
  await call('style_objects',{ids:[rect.shapeId],fill:'#2277AA',outline:{width:0.2,color:'#000000'}});
  const text=await call('create_text',{x:10,y:70,text:'Before migration'});
  await call('style_text',{ids:[text.shapeId],font:'Arial',size:16});
  const original=await call('get_text',{id:text.shapeId});assert.equal(original.text,'Before migration');
  await call('set_text',{ids:[text.shapeId],text:'Verified Swift bridge'});
  const replaced=await call('get_text',{id:text.shapeId});assert.equal(replaced.text,'Verified Swift bridge');
  const found=await call('find_objects',{text:'Verified Swift bridge'});assert.equal(found.objects.length,1);
  const duplicates=await call('duplicate_objects',{ids:[rect.shapeId],dx:40,dy:0,copies:2});assert.equal(duplicates.copies.length,2);
  const deleteId=duplicates.copies[1].shape.shapeId;
  await call('delete_objects',{ids:[deleteId,2147483646]},true);
  const inventory=await call('list_objects',{recursive:true});assert.ok(inventory.objects.some(s=>s.shapeId===deleteId));
  await call('delete_objects',{ids:[deleteId]});
  }
  const converted=await call('convert_to_curves',{ids:[rect.shapeId]});assert.equal(converted.objects[0].type,3);
  const curve=await call('inspect_curve',{id:rect.shapeId});assert.ok(curve.total>=4);
  const preflight=await call('production_preflight',{ids:[rect.shapeId],expectedWidth:30,expectedHeight:20});
  assert.equal(preflight.passed,true);
  const open=await call('create_path',{subpaths:[{start:{x:100,y:10},segments:[{type:'line',x:120,y:10}],closed:false}]});
  const failed=await call('production_preflight',{ids:[open.shapeId]});assert.equal(failed.passed,false);
  await call('delete_objects',{ids:[open.shapeId]});
  // Deliberately activate a different drawing; all scoped edits/files must still
  // target the disposable migration drawing, preserving the bootstrap drawing.
  const bootstrap=before.documents[0];
  if(bootstrap)await call('run_javascript',{code:'var d=host.Documents.Item(1);d.Activate();return {name:d.Name};'});
  const preview=await call('preview',{path:join(output,'preview.png'),width:900,height:600,dpi:144});assert.equal(preview.pixelWidth,900);
  const imageEvidence=evidence.at(-1);assert.equal(imageEvidence.image,true);
  await call('export_file',{path:join(output,'drawing.svg'),format:'svg'});
  await call('export_file',{path:join(output,'drawing.pdf'),format:'pdf'});
  const saved=await call('save_as',{path:join(output,'drawing.cdr')});document=saved.document.id;
  const reopen=await call('run_javascript',{code:'var d=host.ActiveDocument;var path='+JSON.stringify(saved.path)+';if(String(d.FullFileName)!==path)throw new Error("Unexpected active document");d.Close();var reopened=host.OpenDocument(path);return {path:String(reopened.FullFileName),count:reopened.ActivePage.Shapes.Count,pages:reopened.Pages.Count};'});
  assert.equal(reopen.pages,2);assert.equal(reopen.path,saved.path);
  const after=await call('list_documents');
  for(const prior of before.documents){
    const current=after.documents.find(d=>d.id===prior.id);assert.ok(current,'Existing document disappeared');
    assert.deepEqual(current,prior,'Existing document metadata changed');
  }
  const status=await call('status');assert.equal(status.recoveryRequired,false);
  await writeFile(join(output,'summary.json'),JSON.stringify({version:init.serverInfo.version,toolCount:catalog.tools.length,calls:evidence.length,newTools:15,continuedFrom:priorPath,sourceInventoryPreserved:true,reopen,output},null,2));
  console.log('PASS. Evidence: '+output);
}catch(error){console.error(error.stack);console.error('STOPPED. Evidence: '+output);process.exitCode=1;}
finally{child.stdin.end();lines.close();}
