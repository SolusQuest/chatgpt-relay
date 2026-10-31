import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DispatchClient, RequestPool } from '../extension/lib/dispatch-client.js';
function deferred<T=any>() {
  let resolve!:(value:T)=>void, reject!:(reason:any)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
async function until(predicate:()=>boolean) {
  for(let i=0;i<100;i++){if(predicate())return;await Promise.resolve();}
  assert.ok(predicate(),'expected asynchronous state');
}
test('DispatchClient maintains one watch and wake aborts before restarting with null cursor',async()=>{
  let active=0,max=0;
  const requests:any[]=[];
  const client=new DispatchClient({membership:async()=>['sr_1'],onSnapshot:async()=>{},
    watch:async(request:any,signal:AbortSignal)=>{
      active++;max=Math.max(active,max);const gate=deferred();requests.push({request,signal,gate});
      signal.addEventListener('abort',()=>gate.reject(new Error('aborted')),{once:true});
      try{return await gate.promise;}finally{active--;}
    }});
  const running=client.start();assert.equal(client.start(),running);
  await until(()=>requests.length===1);client.wake();
  await until(()=>requests.length===2);
  assert.equal(requests[0].signal.aborted,true);assert.equal(requests[1].request.cursor,null);
  assert.equal(max,1);client.stop();await running;assert.equal(active,0);
});
test('snapshot application completes before cursor advances; wake resets applied cursor',async()=>{
  const requests:any[]=[];const applying=deferred();let entered=false;
  const client=new DispatchClient({membership:async()=>['sr_1'],
    onSnapshot:async()=>{entered=true;await applying.promise;},
    watch:(request:any,signal:AbortSignal)=>{
      const gate=deferred();requests.push({request,gate});signal.addEventListener('abort',()=>gate.reject(new Error('aborted')),{once:true});return gate.promise;
    }});
  const running=client.start();await until(()=>requests.length===1);
  requests[0].gate.resolve({cursor:'cursor-1'});await until(()=>entered);
  assert.equal(client.cursor,null);assert.equal(requests.length,1);
  applying.resolve(undefined);await until(()=>requests.length===2);
  assert.equal(requests[1].request.cursor,'cursor-1');
  client.wake();await until(()=>requests.length===3);assert.equal(requests[2].request.cursor,null);
  client.stop();await running;
});
test('watch failures reset cursor and reconnect; new clients always recover from null',async()=>{
  const requests:any[]=[];const states:any[]=[];let snapshots=0;
  let client:DispatchClient;
  client=new DispatchClient({membership:async()=>['sr_1'],sleep:async()=>{},onState:(state:any)=>states.push(state),
    onSnapshot:async()=>{if(++snapshots===2)client.stop();},
    watch:async(request:any)=>{requests.push(request);if(requests.length===2)throw new Error('offline');return {cursor:'cursor-'+requests.length};}});
  await client.start();assert.deepEqual(requests.map(r=>r.cursor),[null,'cursor-1',null]);
  assert.ok(states.some(s=>s.state==='disconnected'));
  const restartRequests:any[]=[];let restart:DispatchClient;
  restart=new DispatchClient({membership:async()=>['sr_1'],onSnapshot:async()=>restart.stop(),watch:async(request:any)=>{restartRequests.push(request);return {cursor:'recovered'};}});
  await restart.start();assert.equal(restartRequests[0].cursor,null);
});
test('RequestPool limits background work to two and reserves urgent capacity',async()=>{
  const pool=new RequestPool();const gates=[deferred(),deferred(),deferred()];let active=0,max=0,urgent=false;
  const jobs=gates.map(gate=>pool.run(async()=>{active++;max=Math.max(active,max);await gate.promise;active--;},{background:true}));
  await until(()=>active===2);const urgentJob=pool.run(async()=>{urgent=true;});await urgentJob;
  assert.equal(urgent,true);assert.equal(active,2);assert.equal(max,2);
  gates[0]!.resolve(undefined);await until(()=>pool.backgroundActive===2&&active===2);
  gates[1]!.resolve(undefined);gates[2]!.resolve(undefined);await Promise.all(jobs);assert.equal(max,2);
});
test('RequestPool cancels queued aborted requests without executing them',async()=>{
  const pool=new RequestPool(1,1),gate=deferred();let executed=false;
  const first=pool.run(()=>gate.promise);const controller=new AbortController();
  const queued=pool.run(async()=>{executed=true;},{background:true,signal:controller.signal});
  controller.abort();await assert.rejects(queued,/request_aborted/);
  gate.resolve(undefined);await first;await until(()=>pool.active===0);assert.equal(executed,false);
  await assert.rejects(pool.run(async()=>{executed=true;},{signal:controller.signal}),/request_aborted/);
  assert.equal(executed,false);
});
