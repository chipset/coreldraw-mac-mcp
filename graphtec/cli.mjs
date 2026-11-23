#!/usr/bin/env node
import {CorelBridge} from '../src/bridge.mjs';
import {buildOperation} from '../src/tools.mjs';
import {createJob,encodeGPGL,renderJobSVG} from './job.mjs';
import {prepareJobFile} from './prepare.mjs';
import {saveJob,inspectJob,writeNewFile,sendJob,clearSendState} from './service.mjs';
import {probeCutter} from './transport.mjs';

const booleanFlags=new Set(['aligned','panel-matched','verify-device','acknowledge-uncertain']);
const allowed=new Set(['job','output','document','cut-layer','sheet-width','sheet-height','length','thickness','gap','name','host','port','step','sha256','timeout',...booleanFlags]);
function parse(tokens){const args={};for(let i=0;i<tokens.length;i++){
  if(!tokens[i].startsWith('--'))throw new Error('Unexpected argument: '+tokens[i]);
  const key=tokens[i].slice(2);if(!allowed.has(key)||Object.hasOwn(args,key))throw new Error('Unknown or repeated flag: --'+key);
  if(booleanFlags.has(key)){args[key]=true;continue;}
  if(i+1>=tokens.length||tokens[i+1].startsWith('--')||tokens[i+1]==='')throw new Error('Missing value for --'+key);
  args[key]=tokens[++i];
}return args;}
function required(args,key){if(typeof args[key]!=='string'||!args[key])throw new Error('Missing required --'+key);return args[key];}
function numeric(args,key,fallback){if(args[key]===undefined)return fallback;const n=Number(args[key]);if(!Number.isFinite(n))throw new Error('--'+key+' must be finite');return n;}
const help={utility:'Graphtec Sender',version:'0.4.0',commands:['corel-documents','prepare-corel','inspect','export-gpgl','export-svg','probe','send','clear-send-state','demo'],note:'Manual four-point panel alignment required. TCP delivery is not cutting completion. No automatic optical ARMS scanning.'};

export async function runCLI(argv){
  const command=argv[0]||'help',a=parse(argv.slice(1));
  if(command==='help')return help;
  if(command==='corel-documents'){
    const bridge=new CorelBridge({timeoutSeconds:60});const op=await buildOperation('coreldraw_list_documents',{});
    return bridge.run(op.code,op);
  }
  if(command==='prepare-corel'){
    const bridge=new CorelBridge({timeoutSeconds:90});
    return prepareJobFile(bridge,{outputPath:required(a,'output'),document:required(a,'document'),cutLayer:a['cut-layer']||'Sticker Kiss Cut',
      sheetWidthMm:numeric(a,'sheet-width',457.2),sheetHeightMm:numeric(a,'sheet-height',609.6),
      lengthMm:numeric(a,'length',10),thicknessMm:numeric(a,'thickness',.5),gapMm:numeric(a,'gap',20),
      name:a.name||'CorelDRAW print and cut'});
  }
  if(command==='inspect')return inspectJob(required(a,'job'));
  if(command==='demo'){
    const job=createJob({boundsMm:{x:0,y:0,width:100,height:60},paths:[{sourceId:'demo:1',closed:true,
      points:[{x:0,y:0},{x:100,y:0},{x:100,y:60},{x:0,y:60}]}],source:{documentId:'example:offline',pageIndex:1}},
      {name:a.name||'Offline 100 × 60 mm pen-test preview',sheetWidthMm:210,sheetHeightMm:200});
    return saveJob(required(a,'output'),job);
  }
  if(command==='export-gpgl'||command==='export-svg'){
    const {job,sha256}=await inspectJob(required(a,'job'));
    if(command==='export-svg')return {...await writeNewFile(required(a,'output'),renderJobSVG(job)),sha256};
    const {data,...metadata}=encodeGPGL(job,{stepMm:numeric(a,'step',.025)});
    return {...await writeNewFile(required(a,'output'),data),...metadata,sha256,hardwareVerified:false};
  }
  const target={host:required(a,'host'),port:numeric(a,'port',9100),timeoutMs:numeric(a,'timeout',5000)};
  if(command==='probe')return probeCutter(target);
  if(command==='clear-send-state')return clearSendState({...target,acknowledgeUncertain:a['acknowledge-uncertain']===true});
  if(command==='send')return sendJob({...target,jobPath:required(a,'job'),stepMm:numeric(a,'step',.025),sha256:required(a,'sha256'),
    aligned:a.aligned===true,panelMatched:a['panel-matched']===true,verifyDevice:a['verify-device']===true});
  throw new Error('Unknown command: '+command);
}

try{const result=await runCLI(process.argv.slice(2));process.stdout.write(JSON.stringify(result)+'\n');}
catch(error){process.stdout.write(JSON.stringify({error:String(error.message||error),message:String(error.message||error),
  mayHaveSent:error.mayHaveSent===true,recoveryRequired:error.recoveryRequired===true,
  ...(error.preparedPage?{preparedPage:error.preparedPage,recoveryJobPath:error.recoveryJobPath}:{})})+'\n');process.exitCode=1;}
