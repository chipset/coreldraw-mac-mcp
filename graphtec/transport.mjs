import net from 'node:net';

function target(options) {
  const {host,port=9100,timeoutMs=5000}=options;
  if(typeof host!=='string'||host.length>253||host!==host.trim()||(!net.isIP(host)&&!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)))throw new Error('Enter a cutter IP address or hostname without a URL or path');
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Port must be an integer from 1 to 65535');
  if(!Number.isFinite(timeoutMs)||timeoutMs<50||timeoutMs>30000)throw new Error('Connection timeout must be 50–30000 ms');
  return {host,port,timeoutMs};
}

function transfer(options,data) {
  const {host,port,timeoutMs}=target(options),signal=options.signal;
  if(signal?.aborted)return Promise.reject(new Error('Cancelled before connection; no job was sent'));
  return new Promise((resolve,reject)=>{
    let settled=false,mayHaveSent=false;
    const socket=net.createConnection({host,port});
    const finish=(error)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      if(error){error.mayHaveSent=mayHaveSent;socket.destroy();reject(error);return;}
      socket.destroySoon();
      resolve(data?{status:'delivered-to-socket',host,port,bytes:data.length,completionVerified:false,hardwareVerified:false}
        :{reachable:true,host,port,deviceIdentityVerified:false,transport:'tcp',message:'TCP connection only; cutter identity and status are not verified. No commands were sent.'});
    };
    const cancel=()=>finish(new Error(mayHaveSent?'Cancelled after dispatch; some or all bytes may have reached the cutter. Inspect it before another send.':'Cancelled before dispatch; no job was sent'));
    const timer=setTimeout(()=>finish(new Error(mayHaveSent?'Send timed out after dispatch; delivery is uncertain. Inspect the cutter before another send.':'Connection timed out before dispatch; no job was sent')),timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});
    socket.once('error',error=>finish(new Error('Connection failed: '+error.message+(mayHaveSent?'; delivery may be partial. Inspect the cutter before another send.':''))));
    socket.once('connect',()=>{
      if(signal?.aborted){cancel();return;}
      socket.setNoDelay(true);
      if(data)mayHaveSent=true;
      socket.end(data,()=>finish());
    });
    socket.once('close',()=>{if(!settled)finish(new Error(mayHaveSent?'Connection closed during dispatch; delivery is uncertain.':'Connection closed before dispatch'));});
  });
}

export async function probeCutter(options) { return transfer(options); }
export async function sendBytes(options) {
  if(!Buffer.isBuffer(options.data)||options.data.length===0||options.data.length>2*1024*1024)throw new Error('Job payload must be a nonempty Buffer of at most 2 MiB');
  return transfer(options,options.data);
}
