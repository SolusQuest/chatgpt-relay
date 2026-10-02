import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

async function worker(commandState = "claimed", existing = false, discovery = false) {
  const storage: Record<string, any> = { creation_owner: "browser" };
  const operations: string[] = [];
  const meta = { sessionRef: "sr_new", projectId: null, token: "token", owner: "browser", initialTaskId: "task" };
  const marker = `#relay-create=${encodeURIComponent(JSON.stringify(meta))}`;
  const tabs: any[] = existing ? [{ id: 7, url: "https://chatgpt.com/" + marker }] : [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let claimed = false;
  let bridge: any;
  const event = () => ({ addListener() {} });
  const chrome = {
    storage: { local: {
      get: async (key: string) => ({ [key]: structuredClone(storage[key]) }),
      set: async (values: Record<string, unknown>) => Object.assign(storage, values),
    } },
    tabs: {
      query: async () => tabs,
      get: async (id: number) => { const t = tabs.find(t => t.id === id); if (!t) throw new Error("missing"); return t; },
      create: async (options: any) => { operations.push("open-tab"); const tab = { id: 8, ...options }; tabs.push(tab); return tab; },
      sendMessage: async (_id: number, message: any) => message.type === "discover-projects"
        ? { url: "https://chatgpt.com/", projects: [{ projectId: "g-p-" + "a".repeat(32), name: "Project", href: "/g/g-p-" + "a".repeat(32) + "/project" }] }
        : { session: null },
      onRemoved: event(), onUpdated: event(),
    },
    alarms: { getAll: async () => [], create: async () => {}, onAlarm: event() },
    runtime: { onInstalled: event(), onStartup: event(), onMessage: {addListener(fn:any){bridge=fn;}} },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, AbortController, URL,
    console: { log() {}, warn() {} },
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    fetch: async (url: string, options: any) => {
      const route = new URL(url).pathname;
      operations.push(route);
      let response: any = { status: "ok", tasks: [], sessions: [], task: null };
      if (route === "/internal/project-discoveries/claim") {
        response = { command: discovery ? { discoveryId: "scan", token: "scan-token" } : null };
      } else if (route === "/internal/session-controls/claim") {
        response = { command: null };
      } else if (route.endsWith("/claim")) {
        response = { command: claimed ? null : { ...meta, state: commandState, initialTaskId: "task" } };
        claimed = true;
      }
      if (route.endsWith("/fail")) response.request = JSON.parse(options.body);
      if (route.endsWith('/user-stop')) response = {status:'cancelled'};
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    },
  });
  for (const file of ["lib/config.js", "lib/recovery-policy.js", "service-worker.js"]) {
    const source = fs.readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8")
      .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*/gm, "")
      .replace(/\bexport /g, "");
    vm.runInContext(source, context, { filename: file });
  }
  for (let i = 0; i < 15; i++) await new Promise<void>(resolve => setImmediate(resolve));
  return { operations, tabs, context, timers, storage,
    message:(msg:any,tabId=7)=>new Promise<any>(resolve=>bridge(msg,{tab:{id:tabId}},resolve)) };
}

test("snapshot reason distinguishes ready pages from unreachable pages", async () => {
  const w = await worker();
  const reports = await vm.runInContext(`(async()=>{
    const reports=[];
    chrome.tabs.query=async()=>[{id:7}];
    getTabSession=async()=> 'session';
    httpJson=async(method,url,body)=>{reports.push(body);return {};};
    getPageState=async()=>({session:'session',ready:true,generating:false,composerClean:true,reason:null});
    await reportSessionSnapshots();
    getPageState=async()=>{throw new Error('unreachable');};
    await reportSessionSnapshots();
    return reports;
  })()`, w.context);
  assert.equal(reports[0].ready, true);
  assert.equal(reports[0].reason, null);
  assert.equal(reports[1].ready, null);
  assert.equal(reports[1].reason, "page_unreachable");
});

test("worker persists the creation open fence before opening one tab", async () => {
  const w = await worker();
  assert.equal(w.operations.filter(x => x === "open-tab").length, 1);
  assert.ok(w.operations.indexOf("/internal/session-creations/sr_new/opening") < w.operations.indexOf("open-tab"));
  assert.ok(w.operations.indexOf("/internal/session-creations/sr_new/attach") > w.operations.indexOf("open-tab"));
  assert.equal(w.tabs[0].active, false);
  assert.match(w.tabs[0].url, /#relay-create=/);
});

test("explicit recovery attaches original evidence without submitting or requeueing", async () => {
  const w = await worker();
  const result = await vm.runInContext(`(async()=>{
    const calls=[];
    getTabSession=async()=> 'session';
    httpJson=async(method,url)=> {calls.push(url); return {taskId:'task',session:'session',status:'recovering',sendAttemptedAt:1};};
    getPendingReply=async()=>({taskId:'task',tabId:7,baseline:{lastUserId:'old'},submittedUserMessageId:'new'});
    getInflight=async()=>null;
    attachPendingFromTask=async(task,session,tab,record)=>calls.push(record.submittedUserMessageId);
    pollPendingReplies=async()=>{};
    const result=await executeSessionControl({kind:'recover',session:'session',tabId:7,taskId:'task'});
    return {result,calls};
  })()`, w.context);
  assert.equal(result.result.action, "observation_attached");
  assert.deepEqual(Array.from(result.calls), ["/v1/tasks/task", "new"]);
  await vm.runInContext("getPendingReply=async()=>null", w.context);
  await assert.rejects(vm.runInContext("executeSessionControl({kind:'recover',session:'session',tabId:7,taskId:'task'})", w.context), /recovery_evidence_unavailable/);
});

test("refresh verifies a new document and never repeats a fenced reload", async () => {
  const w = await worker();
  const result = await vm.runInContext(`(async()=>{
    let reloads=0, fences=0;
    getTabSession=async()=> 'session';
    getPageState=async()=>({session:'session',ready:true,generating:false,composerClean:true,documentId:reloads?'new':'old'});
    httpJson=async()=> {fences++; return {execute:true,result:{beforeDocumentId:'old'}};};
    sendTabMessage=async()=>{reloads++; return {reloading:true};};
    const command={kind:'refresh',session:'session',tabId:7,operationId:'operation',state:'claimed',expiresAt:Date.now()+1000};
    const first=await executeSessionControl(command);
    const second=await executeSessionControl({...command,state:'executing',result:{beforeDocumentId:'old'}});
    return {first,second,reloads,fences};
  })()`, w.context);
  assert.equal(result.first.action, "page_refreshed");
  assert.equal(result.second.action, "page_refreshed");
  assert.equal(result.reloads, 1);
  assert.equal(result.fences, 1);
});

for (const status of ["failed", "cancelled"]) {
  test(`a new document alone cannot certify preservation of a ${status} task`, async () => {
    const w = await worker();
    w.context.terminalStatus = status;
    await vm.runInContext(`
      getPageState=async()=>({session:'session',ready:true,documentId:'new'});
      httpJson=async()=>({status:terminalStatus});
    `, w.context);
    await assert.rejects(vm.runInContext(`executeRefreshControl({tabId:7,session:'session',taskId:'task',
      state:'executing',result:{beforeDocumentId:'old'},expiresAt:Date.now()+1000})`, w.context), /refresh_task_not_preserved/);
  });
}

test("Stop reports page and Relay outcomes separately and records original task intent", async () => {
  const w = await worker();
  const result = await vm.runInContext(`(async()=>{
    let clicked=0,record={session:'session',tabId:7,taskId:'task',submittedUserMessageId:'user'};
    getTabSession=async()=> 'session';
    getPageState=async()=>({session:'session',documentId:'doc',generating:false});
    getPendingReply=async()=>record;
    setPendingReply=async(id,value)=>{record=value;};
    pollOnePending=async()=>{};
    httpJson=async(method,url)=>url.endsWith('/fence')?{execute:true}:{status:'cancelled'};
    sendTabMessage=async()=>{clicked++;return {clicked:true,stopRequestedAt:123};};
    const command={kind:'stop',session:'session',tabId:7,taskId:'task',state:'claimed',expiresAt:Date.now()+1000};
    const result=await executeSessionControl(command);
    await executeSessionControl({...command,state:'executing'});
    return {result,clicked,record};
  })()`, w.context);
  assert.equal(result.clicked, 1);
  assert.equal(result.record.stopRequestedAt, 123);
  assert.equal(result.result.pageGenerationState, "stopped");
  assert.equal(result.result.relayTaskStatus, "cancelled");
});

test("a lost execution fence response reports unknown instead of a retryable block", async () => {
  const w = await worker();
  const outcome = await vm.runInContext(`(async()=>{
    let outcome;
    getTabSession=async()=> 'session';
    getPageState=async()=>({session:'session',ready:true,generating:false,composerClean:true,documentId:'doc'});
    httpJson=async(method,url,body)=>{
      if(url.endsWith('/claim')) return {command:{kind:'refresh',operationId:'op',session:'session',tabId:7,state:'claimed',expiresAt:Date.now()+1000}};
      if(url.endsWith('/fence')) throw new Error('connection lost');
      if(url.endsWith('/finish')) {outcome=body;return {};}
    };
    sendTabMessage=async()=>{throw new Error('must not reload');};
    await processSessionControls();
    return outcome;
  })()`, w.context);
  assert.equal(outcome.state, "unknown");
  assert.equal(outcome.error, "connection lost");
});

test("worker restart finds the previously opened marked tab instead of creating another", async () => {
  const w = await worker("opening", true);
  assert.equal(w.operations.includes("open-tab"), false);
  assert.ok(w.operations.includes("/internal/session-creations/sr_new/attach"));
});

test("ambiguous open with no surviving tab is reported unknown and never replayed", async () => {
  const w = await worker("opening", false);
  assert.equal(w.operations.includes("open-tab"), false);
  assert.ok(w.operations.includes("/internal/session-creations/sr_new/fail"));
});

test("concurrent tab and inflight updates retain all session identities and send evidence", async () => {
  const w = await worker();
  await vm.runInContext(`Promise.all([
    rememberTabSession(11, 'session-A'), rememberTabSession(12, 'session-B'),
    markInflight('session-A', 'task-A', {deliveryPhase:'send-fenced'}),
    markInflight('session-B', 'task-B', {deliveryPhase:'preparing'})
  ])`, w.context);
  assert.equal(w.storage.tab_session_map[11], "session-A");
  assert.equal(w.storage.tab_session_map[12], "session-B");
  assert.equal(w.storage.inflight["session-A"].deliveryPhase, "send-fenced");
  assert.equal(w.storage.inflight["session-B"].taskId, "task-B");
  await vm.runInContext(`Promise.all([clearInflight('session-A', 'task-A'), markInflight('session-B', 'task-B', {deliveryPhase:'accepted'})])`, w.context);
  assert.equal(w.storage.inflight["session-A"], undefined);
  assert.equal(w.storage.inflight["session-B"].deliveryPhase, "accepted");
});

test("worker scans existing tabs without opening discovery tabs or sending chat messages", async () => {
  const w = await worker("opening", true, true);
  assert.equal(w.operations.includes("open-tab"), false);
  assert.ok(w.operations.includes("/internal/project-discoveries/scan/complete"));
});

test("reply completion requires the same user and assistant identities across samples", async () => {
  const w = await worker("opening", true);
  w.context.sample = { status: "reply-ready", reply: "same text" };
  w.context.pending = { session: "conversation", tabId: 7, submittedAt: Date.now(),
    submittedUserMessageId: "expected-user", baseline: {}, completionDeadlineAt: Date.now() + 60000 };
  await vm.runInContext("chrome.tabs.sendMessage = async () => sample", w.context);
  const poll = () => vm.runInContext("pollOnePending('review-task', pending)", w.context);
  const captured = () => w.operations.filter(x => x === "/internal/tasks/review-task/capture").length;
  await poll();
  assert.equal(captured(), 0, "legacy uncorrelated snapshots cannot complete a task");
  w.context.sample = { status: "reply-ready", reply: "same text", submittedUserMessageId: "wrong-user", assistantMessageId: "a1" };
  await poll(); assert.equal(captured(), 0);
  w.context.sample.submittedUserMessageId = "expected-user";
  await poll(); assert.equal(captured(), 0);
  w.context.sample.assistantMessageId = "a2";
  await poll(); assert.equal(captured(), 0, "equal text on a different message resets stability");
  await poll(); assert.equal(captured(), 1);
});

for (const stopLoop of [false, true]) {
  test(`reconciliation does not recover a live preparing dispatch (loop stopped: ${stopLoop})`, async () => {
    const w = await worker("opening", true);
    w.context.events = [];
    await vm.runInContext(`
      tabSessionCache.set(7, 'session');
      getPageState = async () => ({session:'session', ready:true, generating:false, baseline:{}});
      httpJson = async (method, path) => {
        events.push(path);
        if (path.startsWith('/internal/next_task')) return {task:{taskId:'active-task', text:'test'}};
        if (path === '/v1/tasks/active-task') return {taskId:'active-task', session:'session', status:'in_progress'};
        return {};
      };
      let releaseRun;
      const runGate = new Promise(resolve => { releaseRun = resolve; });
      sendTabMessage = async (_tabId, msg) => {
        if (msg.type === 'run-task') { events.push('run-task'); return runGate; }
        return {};
      };
      const runningDispatch = startDispatchLoop('session', 7);
    `, w.context);
    try {
      for (let i = 0; i < 20 && !w.context.events.includes("run-task"); i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.ok(w.context.events.includes("run-task"));
      if (stopLoop) await vm.runInContext("stopDispatchLoop('session')", w.context);
      await vm.runInContext("reconcileInflight()", w.context);
      assert.equal(w.context.events.includes("/internal/tasks/active-task/defer"), false);
      assert.equal(w.storage.inflight.session?.taskId, "active-task");
    } finally {
      await vm.runInContext(`
        stopDispatchLoop('session');
        releaseRun({error:'test stopped before send', submissionState:'not-submitted'});
        runningDispatch;
      `, w.context);
    }
    // A worker restart has no live dispatch owner: pre-send recovery still works.
    await vm.runInContext(`(async () => {
      await markInflight('session', 'active-task', {tabId:7, deliveryPhase:'preparing'});
      await reconcileInflight();
    })()`, w.context);
    assert.ok(w.context.events.includes("/internal/tasks/active-task/defer"));
    assert.equal(w.storage.inflight.session, undefined);
  });
}

for (const interruption of ["stopDispatchLoop('session')", "forgetTabSession(7)"]) {
  test(`interrupting an accepted dispatch preserves the task and send evidence: ${interruption}`, async () => {
    const w = await worker("opening", true);
    w.context.events = [];
    await vm.runInContext(`
      tabSessionCache.set(7,'session');
      getPageState=async()=>({session:'session',ready:true,generating:false,baseline:{lastUserId:'old-user'}});
      httpJson=async(method,path)=>{
        events.push(path);
        if(path.startsWith('/internal/next_task')) return {task:{taskId:'original-task',text:'test'}};
        return {};
      };
      sendTabMessage=async(tab,msg)=>msg.type==='run-task' ?
        {status:'submitted',submittedUserMessageId:'sent-user',baseline:{lastUserId:'old-user'}} : {};
      waitForPendingReply=((original)=>(id,signal)=>{events.push('waiting');return original(id,signal);})(waitForPendingReply);
      const interruptedDispatch=startDispatchLoop('session',7);
    `, w.context);
    for (let i=0; i<30 && !w.context.events.includes('waiting'); i++) await new Promise<void>(r=>setImmediate(r));
    assert.ok(w.context.events.includes('waiting'));
    await vm.runInContext(`${interruption}; interruptedDispatch;`, w.context);
    assert.equal(w.context.events.includes('/internal/tasks/original-task/complete'), false);
    assert.equal(w.storage.inflight.session.taskId, 'original-task');
    const pending = await vm.runInContext("getPendingReply('original-task')", w.context);
    assert.equal(pending.submittedUserMessageId, 'sent-user');
    assert.equal(pending.baseline.lastUserId, 'old-user');
  });
}
test('review: delayed terminal reconciliation must not erase a successor task', async () => {
  const w = await worker('opening',true);
  w.context.events = [];
  await vm.runInContext(`
    tabSessionCache.set(7,'session');
    let releaseTaskRead;
    const taskRead = new Promise(resolve => {releaseTaskRead=resolve;});
    httpJson = async (method,path) => {events.push(path); return taskRead;};
    sendTabMessage = async (_id,msg) => {events.push(msg); return {};};
  `,w.context);
  await vm.runInContext("markInflight('session','old-task',{tabId:7,deliveryPhase:'accepted'})",w.context);
  vm.runInContext("const reconciliation = reconcileInflight();",w.context);
  for(let i=0; i<20 && !w.context.events.includes('/v1/tasks/old-task');i++) await new Promise<void>(r=>setImmediate(r));
  assert.ok(w.context.events.includes('/v1/tasks/old-task'));
  await vm.runInContext("markInflight('session','new-task',{tabId:7,deliveryPhase:'send-fenced'})",w.context);
  await vm.runInContext("releaseTaskRead({taskId:'old-task',status:'done'}); reconciliation;",w.context);
  assert.equal(w.storage.inflight.session?.taskId,'new-task');
  const cleared = w.context.events.find((e:any)=>e.type==='clear-inflight');
  assert.equal(cleared.taskId,'old-task');
  assert.equal(cleared.expectedSession,'session');
});

test('task cleanup finishes on the page before releasing the next dispatch', async () => {
  const w=await worker('opening',true);
  await vm.runInContext(`
    let releasePage;
    const pageGate=new Promise(resolve=>{releasePage=resolve;});
    sendTabMessage=async()=>pageGate;
    let woken=false;
  `,w.context);
  await vm.runInContext("markInflight('session','old-task',{tabId:7})",w.context);
  await vm.runInContext("setPendingReply('old-task',{session:'session',tabId:7})",w.context);
  vm.runInContext("pendingCompletion.get('old-task').promise.then(()=>{woken=true;}); const clearing=clearRecoveredTask('old-task','session',7);",w.context);
  for(let i=0;i<10;i++) await new Promise<void>(r=>setImmediate(r));
  assert.equal(vm.runInContext('woken',w.context),false);
  assert.ok(w.storage.pending_replies['old-task']);
  await vm.runInContext('releasePage({}); clearing;',w.context);
  assert.equal(vm.runInContext('woken',w.context),true);
  assert.equal(w.storage.pending_replies['old-task'],undefined);
});

test('conditional inflight cleanup preserves another task under concurrent storage writes',async()=>{
  const w=await worker();
  await vm.runInContext(`Promise.all([
    markInflight('session','new-task',{deliveryPhase:'send-fenced'}),
    clearInflight('session','old-task')
  ])`,w.context);
  assert.equal(w.storage.inflight.session.taskId,'new-task');
  assert.equal(await vm.runInContext("clearInflight('session')",w.context),false);
  assert.equal(await vm.runInContext("clearInflight('session','new-task')",w.context),true);
});
test('review: Stop with partial assistant text must not complete successfully', async () => {
  const w = await worker('opening',true);
  w.context.partial = {status:'reply-ready',reply:'unfinished review...',submittedUserMessageId:'u2',assistantMessageId:'a2'};
  w.context.pending = {session:'session',tabId:7,taskId:'stopped-task',submittedAt:Date.now(),
    baseline:{},submittedUserMessageId:'u2',wasGenerating:true,deliveryPhase:'accepted',
    submissionAcknowledged:true,stopRequestedAt:Date.now(),completionDeadlineAt:Date.now()+60000};
  await vm.runInContext('chrome.tabs.sendMessage = async () => partial',w.context);
  await vm.runInContext("pollOnePending('stopped-task',pending)",w.context);
  await vm.runInContext("pollOnePending('stopped-task',pending)",w.context);
  assert.equal(w.operations.includes('/internal/tasks/stopped-task/capture'),false);
  assert.ok(w.operations.includes('/internal/tasks/stopped-task/user-stop'));
});

for (const status of ['reply-ready','posted-no-reply-yet','not-started','generating']) {
  test(`Stop waits for generation to end: ${status}`,async()=>{
    const w=await worker('opening',true);
    w.context.rec={taskId:'task',session:'session',tabId:7,baseline:{},submittedAt:Date.now(),
      completionDeadlineAt:Date.now()+60000,stopRequestedAt:Date.now(),submittedUserMessageId:'u2'};
    w.context.snap={status,reply:'partial',submittedUserMessageId:'u2',assistantMessageId:'a2'};
    await vm.runInContext('chrome.tabs.sendMessage=async()=>snap',w.context);
    await vm.runInContext("pollOnePending('task',rec)",w.context);
    assert.equal(w.operations.includes('/internal/tasks/task/user-stop'),status!=='generating');
    assert.equal(w.operations.includes('/internal/tasks/task/capture'),false);
  });
}

test('Stop arriving during completion progress beats partial reply capture',async()=>{
  const w=await worker('opening',true);
  w.context.rec={taskId:'task',session:'session',tabId:7,baseline:{},submittedAt:Date.now(),
    completionDeadlineAt:Date.now()+60000,submittedUserMessageId:'u2',submissionAcknowledged:true,
    submitAcknowledgedProgressReported:true,lastSampleKey:JSON.stringify(['u2','a2']),lastSampleText:'partial',stableSampleCount:1};
  w.context.snap={status:'reply-ready',reply:'partial',submittedUserMessageId:'u2',assistantMessageId:'a2'};
  w.context.events=[];
  await vm.runInContext(`
    chrome.tabs.sendMessage=async()=>snap;
    let releaseProgress;
    const progressGate=new Promise(r=>{releaseProgress=r;});
    httpJson=async(method,path)=>{
      events.push(path);
      if(path.endsWith('/progress')) return progressGate;
      return {status:'cancelled'};
    };
  `,w.context);
  await vm.runInContext("setPendingReply('task',rec)",w.context);
  vm.runInContext("const sampling=pollOnePending('task',rec)",w.context);
  for(let i=0;i<10&&!w.context.events.includes('/internal/tasks/task/progress');i++) await new Promise<void>(r=>setImmediate(r));
  assert.ok(w.context.events.includes('/internal/tasks/task/progress'));
  assert.equal((await w.message({type:'user-stop-requested',taskId:'task',expectedSession:'session',submittedUserMessageId:'u2'})).status,'stop-requested');
  await vm.runInContext('releaseProgress({}); sampling;',w.context);
  assert.equal(w.context.events.includes('/internal/tasks/task/capture'),false);
  assert.ok(w.context.events.includes('/internal/tasks/task/user-stop'));
});

test('failed cancellation retains intent and pending state for retry',async()=>{
  const w=await worker('opening',true);
  w.context.rec={taskId:'task',session:'session',tabId:7,stopRequestedAt:Date.now(),submittedUserMessageId:'u2'};
  await vm.runInContext(`httpJson=async()=>{throw new Error('offline');}`,w.context);
  assert.equal(await vm.runInContext("cancelPending('task',rec,'user stopped')",w.context),false);
  assert.ok(w.storage.pending_replies.task.stopRequestedAt);
  await vm.runInContext("setPendingReply('task',{...rec,stopRequestedAt:null})",w.context);
  assert.ok(w.storage.pending_replies.task.stopRequestedAt,'stale sampler cannot erase intent');
  await vm.runInContext("httpJson=async()=>({status:'cancelled'})",w.context);
  assert.equal(await vm.runInContext("cancelPending('task',rec,'user stopped')",w.context),true);
  assert.equal(w.storage.pending_replies.task,undefined);
});

test('Stop cannot bind a different tab or submitted user',async()=>{
  const w=await worker('opening',true);
  await vm.runInContext("setPendingReply('task',{taskId:'task',session:'session',tabId:7,submittedUserMessageId:'u2'})",w.context);
  for (const [tabId,user] of [[8,'u2'],[7,'other-user']] as const) {
    assert.ok((await w.message({type:'user-stop-requested',taskId:'task',expectedSession:'session',submittedUserMessageId:user},tabId)).error);
    assert.equal(w.storage.pending_replies.task.stopRequestedAt,null);
  }
});

test('a late Stop preserves an already completed result',async()=>{
  const w=await worker('opening',true);
  await vm.runInContext("httpJson=async()=>({status:'done'})",w.context);
  await vm.runInContext("cancelPending('task',{session:'session',tabId:7},'user stopped')",w.context);
  assert.equal(w.storage.last_error,undefined);
});

test('overlapping samplers share one task snapshot',async()=>{
  const w=await worker('opening',true);
  w.context.rec={taskId:'task',session:'session',tabId:7,baseline:{},submittedAt:Date.now(),completionDeadlineAt:Date.now()+60000};
  await vm.runInContext(`let reads=0; let releaseSnapshot;
    const gate=new Promise(r=>{releaseSnapshot=r;});
    chrome.tabs.sendMessage=async()=>{reads++; return gate;};
    const first=pollOnePending('task',rec);
    const second=pollOnePending('task',{...rec});
  `,w.context);
  for(let i=0;i<10;i++) await new Promise<void>(r=>setImmediate(r));
  assert.equal(vm.runInContext('reads',w.context),1);
  await vm.runInContext("releaseSnapshot({status:'generating'}); Promise.all([first,second]);",w.context);
});

for(const status of ['in_progress','done']) {
  test(`refresh recovery honors Stop without changing terminal success: ${status}`,async()=>{
    const w=await worker('opening',true);
    w.context.events=[]; w.context.taskStatus=status;
    await vm.runInContext(`httpJson=async(method,path)=>{
      events.push(path);
      return {taskId:'task',session:'session',status:taskStatus};
    };`,w.context);
    const result=await vm.runInContext("recoverInflightForTab({taskId:'task',phase:'accepted',stopRequestedAt:123,submittedUserMessageId:'u2'},7)",w.context);
    assert.equal(result.status,status==='done'?'done':'cancelled');
    assert.equal(w.context.events.includes('/internal/tasks/task/user-stop'),status==='in_progress');
    assert.equal(w.context.events.includes('/internal/tasks/task/capture'),false);
  });
}
