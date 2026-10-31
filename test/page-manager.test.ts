import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageManager } from '../extension/lib/page-manager.js';
function harness() {
  let time = 100000;
  const storage: Record<string, any> = {};
  const tabs: any[] = [];
  const pages: Record<number, any> = {};
  const servers: Record<string, any> = {};
  const pending: any[] = [], closed: number[] = [];
  let closeWorks = true, onSample: ((id:number)=>void) | null = null;
  const manager = createPageManager({
    storageGet: async key => structuredClone(storage[key]), storageSet: async (key,value) => { storage[key] = structuredClone(value); },
    listTabs: async () => structuredClone(tabs), now: () => time,
    getPageState: async id => { const page = structuredClone(pages[id]); onSample?.(id); return page; },
    inspectSession: async session => structuredClone(servers[session]), listPending: async () => pending,
    closePage: async (record,state) => { assert.equal(state.activityRevision,pages[record.tabId].activityRevision); closed.push(record.tabId);
      if (closeWorks) tabs.splice(tabs.findIndex(tab=>tab.id===record.tabId),1); },
  });
  async function add(id:number, overrides:Record<string,any> = {}) {
    const session = `sr_${id}`;
    tabs.push({id,active:false,pinned:false});
    pages[id] = {session,conversationId:`abc-${id}`,documentId:`doc-${id}`,ready:true,generating:false,composerClean:true,
      lastUserActivityAt:null,activityRevision:0};
    servers[session] = {safeIdle:true,queued:false,activeTask:false,recovery:false,latePending:false,controlsPending:false};
    await manager.remember(id,{session,conversationId:`abc-${id}`,provenance:'relay',lifecyclePolicy:'reclaimable',lastTaskActivityAt:1,...overrides});
  }
  return {manager,storage,tabs,pages,servers,pending,closed,add,setCloseWorks:(value:boolean)=>{closeWorks=value;},
    onSample:(callback:(id:number)=>void)=>{onSample=callback;},advance:()=>{time+=60001;}};
}
test('serial reservations prevent concurrent creations exceeding capacity', async () => {
  const h=harness(); let opened=0;
  const open=()=>h.manager.withSlot(async()=>{opened++;await h.add(opened,{conversationId:null,lastTaskActivityAt:100000});},1);
  const result=await Promise.allSettled([open(),open()]);
  assert.equal(opened,1);assert.equal(result[1].status,'rejected');assert.equal(h.closed.length,0);
});
test('protected pages are ignored by cap and never evicted',async()=>{
  const h=harness();await h.add(1,{lifecyclePolicy:'protected',provenance:'manual'});
  await h.manager.withSlot(()=>h.add(2),1);
  await h.manager.withSlot(()=>h.add(3,{lastTaskActivityAt:100000}),1);
  assert.deepEqual(h.closed,[2]);assert.ok(h.tabs.some(t=>t.id===1));
});
test('oldest safe page is parked only after confirmed disappearance',async()=>{
  const h=harness();await h.add(1,{lastTaskActivityAt:2});await h.add(2,{lastTaskActivityAt:1});
  await h.manager.withSlot(()=>h.add(3),2);
  assert.deepEqual(h.closed,[2]);assert.equal(h.storage.parked_sessions.sr_2.status,'closed');
});
for(const blocker of ['queued','activeTask','recovery','latePending','controlsPending']) test(`server ${blocker} protects page`,async()=>{
  const h=harness();await h.add(1);h.servers.sr_1[blocker]=true;
  await assert.rejects(h.manager.withSlot(()=>h.add(2),1),/waiting_for_capacity/);assert.deepEqual(h.closed,[]);
});
test('pending reply and pinned/active pages cannot be reclaimed',async()=>{
  for(const mode of ['pending','pinned','active','draft','recent']){
    const h=harness();await h.add(1);
    if(mode==='pending')h.pending.push({session:'sr_1'});
    if(mode==='pinned'||mode==='active')h.tabs[0][mode]=true;
    if(mode==='draft')h.pages[1].composerClean=false;
    if(mode==='recent')h.pages[1].lastUserActivityAt=99999;
    await assert.rejects(h.manager.withSlot(()=>h.add(2),1),/waiting_for_capacity/);assert.deepEqual(h.closed,[]);
  }
});
test('activity changes during sampling prevent close',async()=>{
  const h=harness();await h.add(1);h.onSample(()=>{h.pages[1].activityRevision++;});
  await assert.rejects(h.manager.withSlot(()=>h.add(2),1),/waiting_for_capacity/);assert.deepEqual(h.closed,[]);
});
test('uncertain close leaves intent and never opens duplicate',async()=>{
  const h=harness();await h.add(1);h.setCloseWorks(false);let opened=false;
  await assert.rejects(h.manager.withSlot(()=>{opened=true;},1),/waiting_for_capacity/);
  assert.equal(opened,false);assert.equal(h.storage.parked_sessions.sr_1.status,'closing');
  assert.ok(h.storage.page_lifecycle[1]);
});

test('manual provenance requires explicit policy grant and execution never grants management',async()=>{
  const h=harness();await h.add(1,{provenance:'manual',lifecyclePolicy:'protected'});
  await h.manager.noteActivity('sr_1');h.advance();
  assert.equal((await h.manager.capacity(1)).managedCount,0);
  assert.equal(h.storage.page_lifecycle[1].managementGranted,undefined);
  await h.manager.setPolicy(1,'reclaimable');
  assert.equal(h.storage.page_lifecycle[1].provenance,'manual');
  assert.equal((await h.manager.capacity(1)).managedCount,1);
  await h.manager.withSlot(()=>h.add(2),1);
  assert.deepEqual(h.closed,[1]);
});

test('manual navigation cannot inherit a previous session management grant',async()=>{
  const h=harness();await h.add(1);await h.manager.setPolicy(1,'reclaimable');
  await h.manager.remember(1,{session:'manual-new',conversationId:'new-conversation'});
  assert.equal(h.storage.page_lifecycle[1].lifecyclePolicy,'protected');
  assert.equal(h.storage.page_lifecycle[1].provenance,'manual');
  assert.equal(h.storage.page_lifecycle[1].managementGranted,undefined);
});
