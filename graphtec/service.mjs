import {open,lstat,mkdtemp,mkdir,link,unlink,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,isAbsolute,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validateJob,encodeGPGL} from './job.mjs';
import {sendBytes} from './transport.mjs';

const hash=data=>createHash('sha256').update(data).digest('hex');
const execute=promisify(execFile);
async function processStart(pid){
  try{const {stdout}=await execute('/bin/ps',['-p',String(pid),'-o','lstart='],{env:{...process.env,LC_ALL:'C',TZ:'UTC'},timeout:2000,maxBuffer:4096});return stdout.trim()||null;}
  catch(error){if(error.code===1)return null;throw new Error('Cannot verify sender process identity: '+error.message);}
}
export async function assertNewPath(path) {
  if(typeof path!=='string'||!isAbsolute(path))throw new Error('Output must be an absolute path');
  const parent=await lstat(dirname(path));if(!parent.isDirectory())throw new Error('Output parent must be a directory');
  try{await lstat(path);throw new Error('Output already exists; overwriting is disabled');}catch(e){if(e.code!=='ENOENT')throw e;}
}
export async function writeNewFile(path,data) {
  await assertNewPath(path);const dir=await mkdtemp(join(dirname(path),'.graphtec-write-'));
  try{const file=await open(join(dir,'output'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
    try{await file.writeFile(data);await file.sync();}finally{await file.close();}
    await link(join(dir,'output'),path);
  }finally{await rm(dir,{recursive:true,force:true});}
  return {path,bytes:Buffer.byteLength(data)};
}
export async function saveJob(path,job) {
  validateJob(job);const bytes=Buffer.from(JSON.stringify(job));
  await writeNewFile(path,bytes);return {path,job,sha256:hash(bytes)};
}
export async function inspectJob(path) {
  if(typeof path!=='string'||!path)throw new Error('A job file is required');
  const full=resolve(path),file=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW);
  let data;try{const info=await file.stat();if(!info.isFile()||info.size>2*1024*1024)throw new Error('Job must be a regular file of at most 2 MiB');data=await file.readFile();if(data.length>2*1024*1024)throw new Error('Job exceeds 2 MiB');}finally{await file.close();}
  let job;try{job=JSON.parse(data.toString('utf8'));}catch{throw new Error('Job file is not valid JSON');}
  validateJob(job);const f=job.registration.frame;
  return {path:full,job,sha256:hash(data),hardwareVerified:false,summary:{pathCount:job.paths.length,pointCount:job.paths.reduce((n,p)=>n+p.points.length,0),feedSpanMm:f.top-f.bottom,crossSpanMm:f.right-f.left}};
}
export async function sendStatePath({host,port=9100,stateDir=process.env.GRAPHTEC_SENDER_STATE_DIR||join(homedir(),'Library/Caches/GraphtecSender')}) {
  if(typeof stateDir!=='string'||!isAbsolute(stateDir))throw new Error('Send state directory must be absolute');
  await mkdir(stateDir,{recursive:true,mode:0o700});
  return join(stateDir,hash(JSON.stringify([host,port]))+'.send.json');
}
export async function clearSendState(options) {
  if(options.acknowledgeUncertain!==true)throw new Error('Acknowledge that the cutter has been inspected and its job buffer cleared before clearing uncertain state');
  const path=await sendStatePath(options);
  let record,info;try{const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{info=await file.stat();if(!info.isFile()||info.size>8192)throw new Error('Invalid send state record');try{record=JSON.parse(await file.readFile('utf8'));}catch{if(Date.now()-info.mtimeMs<120000)throw new Error('Send state is incomplete or recent; wait 120 seconds before acknowledged recovery');record={};}}finally{await file.close();}}catch(e){if(e.code==='ENOENT')return {cleared:false,message:'No interrupted send record exists'};throw e;}
  if(record&&Number.isInteger(record.pid)&&record.pid>0){
    const start=await processStart(record.pid);
    if(start){
      const saved=Date.parse(record.startedAt),actual=Date.parse(start+' UTC');
      const reused=typeof record.processStartedAt==='string'?record.processStartedAt!==start:Number.isFinite(saved)&&Number.isFinite(actual)&&actual>saved+2000;
      if(!reused)throw new Error('The sender process is still running; wait for it to finish before recovery');
    }
  }
  await unlink(path);return {cleared:true,message:'Interrupted send record cleared; this does not undo any cutting'};
}
export async function sendJob(options) {
  if(options.aligned!==true||options.panelMatched!==true||options.verifyDevice!==true)throw new Error('Confirm four-point alignment, matching GP-GL panel mode/step and verified target device before sending');
  const inspected=await inspectJob(options.jobPath);
  if(typeof options.sha256!=='string'||options.sha256.toLowerCase()!==inspected.sha256)throw new Error('Job SHA256 changed or does not match the inspected job; reopen and inspect it before sending');
  const encoded=encodeGPGL(inspected.job,{stepMm:options.stepMm??.025});
  const state=await sendStatePath(options);
  const record={pid:process.pid,processStartedAt:await processStart(process.pid),status:'in-flight',host:options.host,port:options.port??9100,sha256:inspected.sha256,startedAt:new Date().toISOString()};
  try{await writeNewFile(state,JSON.stringify(record));}catch(e){if(e.code==='EEXIST'||/already exists/.test(e.message))throw new Error('A previous in-flight or uncertain send exists for this target. Inspect the cutter before clearing its interrupted-send state.');throw e;}
  let delivered=false;
  try{
    const result=await sendBytes({...options,data:encoded.data});
    delivered=true;
    await unlink(state);
    return {...result,sha256:inspected.sha256,stepMm:encoded.stepMm,pathCount:encoded.pathCount,pointCount:encoded.pointCount};
  }catch(e){
    if(delivered)e.mayHaveSent=true;
    if(!e.mayHaveSent)await unlink(state).catch(()=>{});
    else{e.recoveryRequired=true;e.statePath=state;}
    throw e;
  }
}
