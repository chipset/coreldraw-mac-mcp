import {mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareCorel} from './corel.mjs';
import {assertNewPath,saveJob} from './service.mjs';

export async function prepareJobFile(bridge,args,options={}) {
  await assertNewPath(args.outputPath);
  const prepared=await prepareCorel(bridge,args,options);
  try{return {...await saveJob(args.outputPath,prepared.job),native:prepared.native};}
  catch(error){
    const recovery=join(homedir(),'Library/Application Support/Graphtec Sender/Recovered Jobs');
    await mkdir(recovery,{recursive:true,mode:0o700});
    const recovered=await saveJob(join(recovery,randomUUID()+'.graphtec.json'),prepared.job);
    error.message+='; the new Corel page remains available. Recovery job: '+recovered.path;
    error.preparedPage=prepared.native;error.recoveryJobPath=recovered.path;throw error;
  }
}
