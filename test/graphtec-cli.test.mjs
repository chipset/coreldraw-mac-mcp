import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../graphtec/cli.mjs',import.meta.url));
async function invoke(args){try{const r=await exec(process.execPath,[cli,...args]);return {code:0,value:JSON.parse(r.stdout)};}catch(e){let value;try{value=JSON.parse(e.stdout);}catch{value={error:e.message};}return {code:e.code,value};}}
test('CLI creates and inspects an offline demo and exports only GPGL movements',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'graphtec-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'demo.graphtec.json');const demo=await invoke(['demo','--output',path]);assert.equal(demo.code,0,JSON.stringify(demo));
  const inspect=await invoke(['inspect','--job',path]);assert.equal(inspect.code,0);assert.match(inspect.value.sha256,/^[a-f0-9]{64}$/);
  const out=join(dir,'cut.gpgl');const exported=await invoke(['export-gpgl','--job',path,'--output',out,'--step','0.025']);assert.equal(exported.code,0,JSON.stringify(exported));
  const data=await readFile(out,'ascii');assert.match(data,/^M/);assert.doesNotMatch(data,/TB|IN|J1|!/);
  const duplicate=await invoke(['demo','--output',path]);assert.notEqual(duplicate.code,0);assert.match(duplicate.value.error,/exist|overwrite/i);
});
test('CLI refuses incomplete send requests and unknown flags with structured errors',async()=>{
  for(const args of [['send','--job','missing.json'],['inspect','--job','missing.json','--force'],['probe','--host','http://cutter/']]){
    const result=await invoke(args);assert.notEqual(result.code,0);assert.equal(typeof result.value.error,'string');
  }
});
