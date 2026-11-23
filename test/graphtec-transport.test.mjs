import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
const api = await import('../graphtec/transport.mjs').catch(() => ({}));

async function receiver(t, handler) {
  const server=net.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {host:'127.0.0.1',port:server.address().port};
}
test('network transport exports a probe and one-shot sender',()=>{
  assert.equal(typeof api.probeCutter,'function');assert.equal(typeof api.sendBytes,'function');
});
test('connection probe sends no commands and does not claim cutter identity',async t=>{
  let received=0,connections=0,ended;
  const done=new Promise(resolve=>ended=resolve);
  const target=await receiver(t,socket=>{connections++;socket.on('data',b=>received+=b.length);socket.on('end',()=>{socket.end();ended();});});
  const result=await api.probeCutter(target);
  await done;
  assert.equal(result.reachable,true);assert.equal(result.deviceIdentityVerified,false);
  assert.equal(received,0);assert.equal(connections,1);
});
test('sender delivers exact GPGL bytes once and reports socket delivery only',async t=>{
  let connections=0,complete;const chunks=[];
  const done=new Promise(resolve=>complete=resolve);
  const target=await receiver(t,socket=>{connections++;socket.on('data',b=>chunks.push(b));socket.on('end',()=>{socket.end();complete();});});
  const data=Buffer.from('M0,0\x03D100,0,100,100,0,100,0,0\x03M0,0\x03','ascii');
  const result=await api.sendBytes({...target,data});await done;
  assert.deepEqual(Buffer.concat(chunks),data);assert.equal(connections,1);
  assert.equal(result.status,'delivered-to-socket');assert.equal(result.bytes,data.length);
  assert.equal(result.completionVerified,false);
});
test('invalid targets/payloads and pre-dispatch cancellation never connect',async t=>{
  let connections=0;const target=await receiver(t,s=>{connections++;s.end();});
  for(const options of [{...target,host:'http://127.0.0.1'}, {...target,port:0}, {...target,port:1.5},
    {...target,data:Buffer.alloc(0)}, {...target,data:Buffer.alloc(2*1024*1024+1)}]){
    await assert.rejects(api.sendBytes({data:Buffer.from('M0,0\x03'),...options}));
  }
  const controller=new AbortController();controller.abort();
  await assert.rejects(api.sendBytes({...target,data:Buffer.from('M0,0\x03'),signal:controller.signal}),/cancel|abort/i);
  assert.equal(connections,0);
});
test('refused connection fails without claiming successful delivery',async()=>{
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  await assert.rejects(api.sendBytes({host:'127.0.0.1',port,data:Buffer.from('M0,0\x03')}),error=>{
    assert.equal(error.mayHaveSent,false);return /connect|refused/i.test(error.message);
  });
});
