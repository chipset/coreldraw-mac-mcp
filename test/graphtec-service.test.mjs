import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,readFile,writeFile,utimes,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createJob,encodeGPGL} from '../graphtec/job.mjs';
const api=await import('../graphtec/service.mjs').catch(()=>({}));
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'graphtec-service-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
function job(){return createJob({boundsMm:{x:0,y:0,width:20,height:10},paths:[{sourceId:'1:1',closed:true,points:[{x:0,y:0},{x:20,y:0},{x:20,y:10},{x:0,y:10}]}],source:{documentId:'name:Test',pageIndex:1}},{name:'Test'});}
test('job files are no-clobber and inspect returns an exact byte SHA256',async t=>{
  const dir=await fixture(t),path=join(dir,'job.graphtec.json');
  const saved=await api.saveJob(path,job());const inspected=await api.inspectJob(path);
  assert.equal(saved.sha256,inspected.sha256);assert.match(inspected.sha256,/^[a-f0-9]{64}$/);
  assert.equal(inspected.summary.pathCount,1);assert.equal(inspected.hardwareVerified,false);
  const before=await readFile(path);await assert.rejects(api.saveJob(path,job()),/exist|overwrite/i);assert.deepEqual(await readFile(path),before);
});
test('invalid job and missing send confirmations never contact the target',async t=>{
  const dir=await fixture(t),path=join(dir,'job.json');const saved=await api.saveJob(path,job());let connections=0;
  const server=net.createServer(s=>{connections++;s.destroy();});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base={jobPath:path,host:'127.0.0.1',port:server.address().port,sha256:saved.sha256,stateDir:join(dir,'state')};
  await assert.rejects(api.sendJob(base),/align|panel|verify/i);
  await assert.rejects(api.sendJob({...base,aligned:true,panelMatched:true,verifyDevice:true,sha256:'0'.repeat(64)}),/changed|hash|SHA/i);
  assert.equal(connections,0);
});
test('sender uses inspected immutable job bytes once and only sends cut paths',async t=>{
  const dir=await fixture(t),path=join(dir,'job.json'),saved=await api.saveJob(path,job());let done;const chunks=[];
  const received=new Promise(r=>done=r),server=net.createServer(s=>{s.on('data',b=>chunks.push(b));s.on('end',()=>{s.end();done();});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const options={jobPath:path,host:'127.0.0.1',port:server.address().port,sha256:saved.sha256,stateDir:join(dir,'state'),aligned:true,panelMatched:true,verifyDevice:true,stepMm:.025};
  const result=await api.sendJob(options);await received;
  assert.equal(result.status,'delivered-to-socket');assert.equal(result.completionVerified,false);
  assert.deepEqual(Buffer.concat(chunks),encodeGPGL(job(),{stepMm:.025}).data);
});
test('an interrupted-send record prevents another dispatch until explicitly cleared',async t=>{
  const dir=await fixture(t),path=join(dir,'job.json'),saved=await api.saveJob(path,job()),stateDir=join(dir,'state');
  const options={jobPath:path,host:'127.0.0.1',port:1,sha256:saved.sha256,stateDir,aligned:true,panelMatched:true,verifyDevice:true};
  const statePath=await api.sendStatePath(options);
  await writeFile(statePath,JSON.stringify({pid:99999999,status:'in-flight',sha256:saved.sha256}));
  await assert.rejects(api.sendJob(options),/previous|uncertain|interrupted|in-flight/i);
  await assert.rejects(api.clearSendState(options),/acknowledge/i);
  await api.clearSendState({...options,acknowledgeUncertain:true});
  await assert.rejects(readFile(statePath),{code:'ENOENT'});
});
test('acknowledged recovery handles old truncated records but leaves recent incomplete writes alone',async t=>{
  const dir=await fixture(t),options={host:'127.0.0.1',port:1,stateDir:dir,acknowledgeUncertain:true};
  const path=await api.sendStatePath(options);await writeFile(path,'{"pid":');
  await assert.rejects(api.clearSendState(options),/incomplete|recent|wait/i);
  await utimes(path,new Date('2020-01-01'),new Date('2020-01-01'));
  assert.equal((await api.clearSendState(options)).cleared,true);
});
test('PID reuse does not permanently block acknowledged stale-send recovery',async t=>{
  const dir=await fixture(t),options={host:'127.0.0.1',port:1,stateDir:dir,acknowledgeUncertain:true};
  const path=await api.sendStatePath(options);
  await writeFile(path,JSON.stringify({pid:process.pid,status:'in-flight',startedAt:'2020-01-01T00:00:00Z'}));
  assert.equal((await api.clearSendState(options)).cleared,true);
});
test('recovery still refuses a matching live process',async t=>{
  const dir=await fixture(t),options={host:'127.0.0.1',port:1,stateDir:dir,acknowledgeUncertain:true};
  const path=await api.sendStatePath(options);
  await writeFile(path,JSON.stringify({pid:process.pid,status:'in-flight',startedAt:new Date().toISOString()}));
  await assert.rejects(api.clearSendState(options),/still running|active/i);
});
