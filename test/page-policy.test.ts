import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPage, evictionCandidates } from '../extension/lib/page-policy.js';
test('ordinary landing pages are discovery and conversations remain addressable', () => {
  assert.equal(classifyPage({pathname:'/'}).pageKind,'discovery');
  assert.equal(classifyPage({pathname:'/g/g-p-'+'a'.repeat(32)+'/project'}).pageKind,'discovery');
  assert.equal(classifyPage({pathname:'/c/abc-123'}).pageKind,'conversation');
  assert.equal(classifyPage({pathname:'/',managed:{sessionRef:'sr_new',token:'token',owner:'browser'}}).pageKind,'creation');
});
const idle = {tabId:1,lifecyclePolicy:'reclaimable',provenance:'relay',conversationId:'abc',safeIdle:true,
  queued:false,activeTask:false,recovery:false,latePending:false,controlsPending:false,draft:false,upload:false,
  pinned:false,active:false,lastUserActivityAt:null,lastTaskActivityAt:1} as const;
test('only explicitly safe Relay conversations are automatic eviction candidates', () => {
  assert.equal(evictionCandidates([idle],{now:100000}).length,1);
  for (const key of ['queued','activeTask','recovery','latePending','controlsPending','draft','upload','pinned','active'])
    assert.equal(evictionCandidates([{...idle,[key]:true}],{now:100000}).length,0,key);
  for (const override of [{lifecyclePolicy:'protected'},{provenance:'manual'},{conversationId:null},{safeIdle:false},
    {lastUserActivityAt:99999},{lastUserActivityAt:undefined}])
    assert.equal(evictionCandidates([{...idle,...override} as any],{now:100000}).length,0);
});
test('ordering is deterministic and uses human/task activity, never heartbeat', () => {
  assert.deepEqual(evictionCandidates([{...idle,tabId:2,lastHeartbeat:99999},{...idle,tabId:1,lastHeartbeat:1}],{now:100000}).map(x=>x.tabId),[1,2]);
});

test('LRU uses most recent user or task activity',()=>{
  assert.deepEqual(evictionCandidates([
    {...idle,tabId:1,lastUserActivityAt:1,lastTaskActivityAt:90000},
    {...idle,tabId:2,lastUserActivityAt:2,lastTaskActivityAt:3},
  ],{now:200000}).map(tab=>tab.tabId),[2,1]);
  assert.equal(evictionCandidates([{...idle,provenance:'manual',managementGranted:true}],{now:100000}).length,1);
});
