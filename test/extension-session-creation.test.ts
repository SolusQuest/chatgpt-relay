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

test("instance inventory reports without page scripts, including an empty complete inventory", async () => {
  const w = await worker();
  const reports = await vm.runInContext(`(async()=>{
    const reports=[];
    chrome.tabs.query=async()=>[];
    chrome.tabs.sendMessage=async()=>{throw new Error('must not probe a page');};
    httpJson=async(method,url,body)=>{reports.push({url,body});return {};};
    await reportBrowserInventory();
    chrome.tabs.query=async()=>[{id:7,url:'https://chatgpt.com/g/g-p-'+ 'a'.repeat(32) +'-name/c/6ac0da0c-f304-83e8-ac0f-25235ca1d760?secret=PRIVATE',status:'loading'}];
    await reportBrowserInventory();
    return reports;
  })()`, w.context);
  assert.equal(reports[0].body.tabs.length, 0);
  assert.equal(reports[1].body.tabs[0].projectId, "g-p-" + "a".repeat(32));
  assert.equal(reports[1].body.tabs[0].loading, true);
  assert.ok(reports[1].body.revision > reports[0].body.revision);
  assert.ok(!JSON.stringify(reports).includes("PRIVATE"));
});

for (const mode of ["new", "reused", "resume-marked", "resume-missing", "ambiguous", "old-generation", "project"]) {
  test(`open existing conversation preserves identity and does not replay: ${mode}`, async () => {
    const w = await worker();
    const result = await vm.runInContext(`(async()=>{
      const id='6ac0da0c-f304-83e8-ac0f-25235ca1d760', mode=${JSON.stringify(mode)};
      const generation=await inventoryGeneration();
      const target={generation:mode==='old-generation'?generation-1:generation,conversationId:id,projectId:mode==='project'?'g-p-'+'a'.repeat(32):null};
      const command={operationId:'open-existing',owner:'browser',token:'token',session:'sr_original',target,
        state:mode.startsWith('resume')?'executing':'claimed',tabId:null,expiresAt:Date.now()+1000};
      let created=0, sends=0, checkpoint=0;
      const url='https://chatgpt.com/c/'+id;
      let tabs=mode==='reused'?[{id:7,url}]:mode==='ambiguous'?[{id:7,url},{id:8,url}]:
        mode==='resume-marked'?[{id:7,url:url+'#relay-open=open-existing'}]:[];
      chrome.tabs.query=async()=>tabs;
      chrome.tabs.get=async(tabId)=>{const tab=tabs.find(t=>t.id===tabId);if(!tab)throw new Error('missing');return tab;};
      chrome.tabs.create=async options=>{created++;const tab={id:9,...options};tabs.push(tab);return tab;};
      chrome.tabs.sendMessage=async()=>{sends++;throw new Error('unexpected prompt dispatch');};
      getTabSession=async()=> 'sr_original';
      getPageState=async()=>({session:'sr_original',documentId:'original',ready:true});
      httpJson=async(method,url,body)=>{if(url.endsWith('/record-tab'))checkpoint++;return {execute:true};};
      try {const outcome=await executeOpenControl(command);return {created,sends,checkpoint,outcome,tabs};}
      catch(error){return {created,sends,checkpoint,error:error.message};}
    })()`, w.context);
    assert.equal(result.sends, 0);
    assert.equal(result.created, mode === "new" || mode === "project" ? 1 : 0);
    if (mode === "resume-missing") assert.equal(result.error, "open_outcome_unknown");
    else if (mode === "ambiguous") assert.equal(result.error, "page_ambiguous");
    else if (mode === "old-generation") assert.equal(result.error, "instance_generation_changed");
    else {
      assert.equal(result.error, undefined);
      assert.equal(result.outcome.relayReady, true);
      if (result.created) {
        assert.equal(result.checkpoint, 1);
        assert.equal(result.tabs[0].active, false);
      }
      if (mode === "project") assert.ok(result.tabs[0].url.includes("/g/g-p-"));
    }
  });
}

for (const mode of ["idle", "draft", "generating", "draft-after-fence", "navigation", "resume-present", "resume-missing", "old-generation", "ambiguous"]) {
  test(`close checks fresh page evidence and never repeats removal: ${mode}`, async () => {
    const w = await worker();
    const result = await vm.runInContext(`(async()=>{
      const id='6ac0da0c-f304-83e8-ac0f-25235ca1d760',mode=${JSON.stringify(mode)};
      const generation=await inventoryGeneration();
      const command={operationId:'close-existing',owner:'browser',token:'token',session:'sr_original',
        target:{generation:mode==='old-generation'?generation-1:generation,conversationId:id,projectId:null},
        state:mode.startsWith('resume')?'executing':'claimed',tabId:7,expiresAt:Date.now()+1000};
      let removed=0,fenced=0;
      let tabs=mode==='resume-missing'?[]:[{id:7,url:'https://chatgpt.com/c/'+id}];
      if(mode==='ambiguous')tabs.push({id:8,url:'https://chatgpt.com/c/'+id});
      chrome.tabs.query=async()=>tabs;
      chrome.tabs.get=async(tabId)=>{const tab=tabs.find(t=>t.id===tabId);if(!tab)throw new Error('missing');return tab;};
      chrome.tabs.remove=async(tabId)=>{removed++;tabs=tabs.filter(t=>t.id!==tabId);};
      getTabSession=async()=> 'sr_original';
      getPageState=async()=>({session:'sr_original',documentId:'original',ready:true,composerClean:mode!=='draft',generating:mode==='generating'});
      chrome.tabs.sendMessage=async()=>mode==='draft-after-fence'?{error:'composer_not_clean'}:{closeAllowed:true};
      httpJson=async(method,url,body)=>{if(url.endsWith('/fence')){fenced++;if(mode==='navigation')tabs[0].url='https://chatgpt.com/';}return {execute:true};};
      try{return {outcome:await executeCloseControl(command),removed,fenced};}
      catch(error){return {error:error.message,removed,fenced};}
    })()`, w.context);
    assert.equal(result.removed, mode === "idle" ? 1 : 0);
    if (mode === "idle" || mode === "resume-missing") assert.equal(result.outcome.action, "page_closed");
    else assert.ok(result.error);
    if (mode === "draft" || mode === "generating") assert.equal(result.fenced, 0);
  });
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
    getPageState=async()=>({session:'session',ready:false,reason:'conversation_blocked',
      block:{code:'conversation_blocked',text:'会話の上限'}});
    await reportSessionSnapshots();
    getPageState=async()=>{throw new Error('unreachable');};
    await reportSessionSnapshots();
    return reports;
  })()`, w.context);
  assert.equal(reports[0].ready, true);
  assert.equal(reports[0].reason, null);
  assert.equal(reports[1].block.code, "conversation_blocked");
  assert.equal(reports[1].block.text, "会話の上限");
  assert.equal(reports[2].ready, null);
  assert.equal(reports[2].reason, "page_unreachable");
  assert.equal(reports[2].block, null);
});

test("a conversation error pauses dispatch before claiming or sending another task", async () => {
  const w = await worker("opening", true);
  const calls = await vm.runInContext(`(async()=>{
    const calls=[];
    tabSessionCache.set(7,'session');
    sendTabMessage=async(tab,msg)=>{
      calls.push({type:msg.type});
      if(msg.type!=='check-safety') throw new Error('must not send');
      return {block:{code:'conversation_blocked',reason:'Conversation error alert detected',text:'会話の上限'}};
    };
    httpJson=async(method,path,body)=>{calls.push({path,body});return {};};
    await startDispatchLoop('session',7);
    return calls;
  })()`, w.context);
  const pause = calls.find((call: any) => call.path?.endsWith('/status'));
  assert.equal(pause.body.paused, true);
  assert.equal(pause.body.reason, "conversation_blocked: 会話の上限");
  assert.ok(!calls.some((call: any) => call.path?.startsWith('/internal/next_task')));
  assert.ok(!calls.some((call: any) => call.type === 'run-task'));
});

test("a conversation error after Send fails the original task without resetting or resending", async () => {
  const w = await worker("opening", true);
  const calls = await vm.runInContext(`(async()=>{
    const calls=[];
    const rec={session:'session',tabId:7,submittedAt:Date.now(),deliveryPhase:'accepted',
      submittedUserMessageId:'user',baseline:{},completionDeadlineAt:Date.now()+60000};
    sendTabMessage=async(tab,msg)=>{
      calls.push({type:msg.type});
      if(msg.type==='clear-inflight') return {cleared:true};
      if(msg.type!=='poll-reply') throw new Error('must not touch composer or Send');
      return {status:'safety',code:'conversation_blocked',reason:'Conversation error alert detected'};
    };
    httpJson=async(method,path,body)=>{calls.push({path,body});return {};};
    await pollOnePending('task',rec);
    return calls;
  })()`, w.context);
  assert.equal(calls.find((call: any) => call.path?.endsWith('/status')).body.reason, "conversation_blocked");
  assert.equal(calls.find((call: any) => call.path?.endsWith('/complete')).body.error, "conversation_blocked");
  assert.ok(!calls.some((call: any) => ['run-task', 'reset-composer'].includes(call.type)));
});

test("reopened ref-created chats normalize page and worker identity before the send fence", async () => {
  const w = await worker();
  const result = await vm.runInContext(`(async()=>{
    const conversationId='6ac0da0c-f304-83e8-ac0f-25235ca1d760';
    let page={session:conversationId,conversationId,managed:null,projectId:null};
    const calls=[];
    chrome.tabs.sendMessage=async(tabId,msg)=>{
      calls.push(msg.type);
      if(msg.type==='configure-session-identity') page={...page,session:msg.session};
      return page;
    };
    httpJson=async(method,url)=> url.includes('/inspect')
      ? {session:'sr_original',sessionRef:'sr_original',conversationId,creationStatus:'created'}
      : {taskId:'task',session:'sr_original',status:'in_progress',sendAttemptedAt:1};
    attachPendingFromTask=async()=>true;
    const session=await getTabSession(7,{forceFresh:true});
    return {session,page,calls};
  })()`, w.context);
  assert.equal(result.session, "sr_original");
  assert.equal(result.page.session, "sr_original");
  assert.ok(result.calls.includes("configure-session-identity"));
  assert.equal(w.storage.tab_session_map[7], "sr_original");
  assert.equal((await w.message({ type: "send-attempted", taskId: "task", baseline: {} })).status, "fenced");
});

for (const scenario of ["new-manual", "network-error", "wrong-conversation", "wrong-ref", "navigation", "configuration-error", "hello"]) {
  test(`reopened conversation registration handles ${scenario}`, async () => {
    const w = await worker();
    w.context.identityScenario = scenario;
    w.context.identityDispatched = null;
    const result = await vm.runInContext(`(async()=>{
      const conversationId='6ac0da0c-f304-83e8-ac0f-25235ca1d760';
      const original={session:conversationId,conversationId,managed:null};
      let configured=0,dispatched=null;
      chrome.tabs.sendMessage=async(tabId,msg)=>{
        if(msg.type==='configure-session-identity') {
          configured++;
          if(identityScenario==='configuration-error') return {error:'session_identity_changed'};
          if(identityScenario==='navigation') return {...original,conversationId:'different'};
          return {...original,session:msg.session};
        }
        return original;
      };
      httpJson=async()=>{
        if(identityScenario==='new-manual') throw Object.assign(new Error('missing'),{status:404});
        if(identityScenario==='network-error') throw new Error('offline');
        return {session:'sr_original',sessionRef:identityScenario==='wrong-ref'?'sr_other':'sr_original',
          conversationId:identityScenario==='wrong-conversation'?'other':conversationId,creationStatus:'created'};
      };
      startDispatchLoop=async(session)=>{dispatched=session;identityDispatched=session;};
      if(identityScenario==='hello') return {original,configured,dispatched};
      const session=await getTabSession(7,{forceFresh:true});
      return {session,configured,dispatched};
    })()`, w.context);
    if (scenario === "hello") {
      const response = await w.message({ type: "session-hello", ...result.original });
      assert.equal(response.status, "ok");
      assert.equal(w.storage.tab_session_map[7], "sr_original");
      assert.equal(vm.runInContext("identityDispatched", w.context), "sr_original");
    } else if (scenario === "new-manual") {
      assert.equal(result.session, "6ac0da0c-f304-83e8-ac0f-25235ca1d760");
      assert.equal(result.configured, 0);
    } else {
      assert.equal(result.session, null);
      assert.equal(w.storage.tab_session_map?.[7], undefined);
    }
  });
}

test("canonical restoration resolves an early recovery mismatch without failing or replaying the task", async () => {
  const w = await worker();
  const result = await vm.runInContext(`(async()=>{
    const calls=[];
    getTabSession=async()=> 'sr_original';
    httpJson=async(method,url)=>{
      calls.push(url);
      return {taskId:'task',session:'sr_original',status:'in_progress',sendAttemptedAt:1};
    };
    attachPendingFromTask=async()=>true;
    pollPendingReplies=async()=>{};
    startDispatchLoop=async()=>{};
    const result=await recoverInflightForTab({taskId:'task',conversationChanged:true,
      baseline:{userCount:0},phase:'accepted'},7);
    return {result,calls};
  })()`, w.context);
  assert.equal(result.result.action, "reattached");
  assert.deepEqual(Array.from(result.calls), ["/v1/tasks/task"]);
});

for (const entry of ["cached-lookup", "restore-loops"]) {
  test(`worker restart normalizes persisted conversation IDs before ${entry}`, async () => {
    const w = await worker();
    w.storage.tab_session_map = { 7: "6ac0da0c-f304-83e8-ac0f-25235ca1d760" };
    w.context.identityEntry = entry;
    const result = await vm.runInContext(`(async()=>{
      const conversationId='6ac0da0c-f304-83e8-ac0f-25235ca1d760';
      let page={session:conversationId,conversationId,managed:null};
      let started=null;
      await loadTabSessionCache();
      chrome.tabs.query=async()=>[{id:7}];
      chrome.tabs.sendMessage=async(tabId,msg)=>{
        if(msg.type==='configure-session-identity') page={...page,session:msg.session};
        return page;
      };
      httpJson=async()=>({session:'sr_original',sessionRef:'sr_original',conversationId,creationStatus:'created'});
      startDispatchLoop=async(session)=>{started=session;};
      if(identityEntry==='restore-loops') await restoreDispatchLoops();
      else started=await getTabSession(7);
      return {started,page};
    })()`, w.context);
    assert.equal(result.started, "sr_original");
    assert.equal(result.page.session, "sr_original");
    assert.equal(w.storage.tab_session_map[7], "sr_original");
  });
}

for (const current of [null, "sr_different"]) {
  test(`ref recovery preserves strict identity checks when page identity is ${current ?? "unavailable"}`, async () => {
    const w = await worker();
    w.context.currentIdentity = current;
    const result = await vm.runInContext(`(async()=>{
      const calls=[];
      getTabSession=async()=>currentIdentity;
      httpJson=async(method,url)=>{
        calls.push([method,url]);
        return {taskId:'task',session:'sr_original',status:method==='POST'?'failed':'in_progress',sendAttemptedAt:1};
      };
      clearRecoveredTask=async()=>{};
      const result=await recoverInflightForTab({taskId:'task',conversationChanged:false,phase:'accepted'},7);
      return {result,calls};
    })()`, w.context);
    if (current === null) {
      assert.equal(result.result.action, "wait");
      assert.equal(result.calls.length, 1);
    } else {
      assert.equal(result.result.action, "clear");
      assert.equal(result.result.error, "submission_outcome_unknown");
      assert.ok(result.calls.some((call: [string, string]) => call[0] === "POST" && call[1].endsWith("/complete")));
    }
  });
}

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
    getPageState=async()=>({session:'session',documentId:'doc',generating:false,ready:true,baseline:{lastUserId:'user'}});
    getPendingReply=async()=>record;
    setPendingReply=async(id,value)=>{record=value;};
    pollOnePending=async()=>{};
    httpJson=async(method,url)=>url.endsWith('/fence')?{execute:true}:{taskId:'task',session:'session',status:'cancelled'};
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

for (const status of ['cancelled-stop', 'cancelled-client', 'done', 'failed', 'in_progress']) {
  for (const pageCase of ['original', 'draft', 'new-turn', 'generating', 'hydrating', 'other-session', 'unreachable', 'legacy-fence']) {
    test(`resumed Stop observes durable outcome without pending state: ${status}, ${pageCase}`, async () => {
      const w = await worker();
      w.context.taskStatus = status;
      w.context.pageCase = pageCase;
      const result = await vm.runInContext(`(async()=>{
        getTabSession=async()=> 'session';
        getPageState=async()=>{
          if(pageCase==='unreachable') throw new Error('page unavailable');
          return {session:pageCase==='other-session'?'other':'session',documentId:'doc',
            ready:!['hydrating','draft'].includes(pageCase),
            ...(pageCase==='draft'?{observationReady:true}:{}),generating:pageCase==='generating',
            baseline:{lastUserId:pageCase==='new-turn'?'new-user':'original-user'}};
        };
        sendTabMessage=async()=>{throw new Error('must never replay Stop');};
        httpJson=async(method,url)=>{
          if(method!=='GET' || url!=='/v1/tasks/task') throw new Error('unexpected mutation');
          return {taskId:'task',session:'session',status:taskStatus.startsWith('cancelled')?'cancelled':taskStatus,
            error:taskStatus==='cancelled-stop'?'user stopped before reply':'cancelled by client'};
        };
        return executeStopControl({kind:'stop',state:'executing',session:'session',taskId:'task',tabId:7,
          expiresAt:Date.now()-1,result:{beforeDocumentId:'doc',
            ...(pageCase==='legacy-fence'?{}:{submittedUserMessageId:'original-user'})}});
      })()`,w.context);
      assert.equal(result.stopRequested, status === 'cancelled-stop' ? true : null);
      assert.equal(result.relayTaskStatus, status.startsWith('cancelled') ? 'cancelled' : status);
      assert.equal(result.pageGenerationState, ['original','draft'].includes(pageCase) ? 'stopped' : pageCase === 'generating' ? 'generating' : 'unknown');
    });
  }
}

test('resumed Stop rejects foreign server task identity',async()=>{
  const w=await worker();
  await vm.runInContext(`
    getTabSession=async()=> 'session';
    getPageState=async()=>({session:'session',ready:true,generating:false,baseline:{lastUserId:'user'}});
    httpJson=async()=>({taskId:'task',session:'other',status:'cancelled',error:'user stopped before reply'});
  `,w.context);
  await assert.rejects(vm.runInContext(`executeStopControl({state:'executing',session:'session',taskId:'task',tabId:7,
    expiresAt:Date.now()-1,result:{submittedUserMessageId:'user'}})`,w.context),/stop_task_identity_mismatch/);
});

test('worker restart after Stop cleanup and lost finish response recovers success without another click',async()=>{
  const w=await worker();
  const evidence=await vm.runInContext(`(async()=>{
    const command={kind:'stop',session:'session',taskId:'task',tabId:7,state:'claimed',operationId:'stop-op',token:'token',expiresAt:Date.now()+60000};
    let clicks=0, outcome;
    getTabSession=async()=> 'session';
    getPageState=async()=>({session:'session',documentId:'doc',ready:true,generating:false,baseline:{lastUserId:'user'}});
    await markInflight('session','task',{tabId:7,deliveryPhase:'accepted'});
    await setPendingReply('task',{taskId:'task',session:'session',tabId:7,submittedUserMessageId:'user'});
    sendTabMessage=async(tab,msg)=>{if(msg.type==='stop-generation'){clicks++;return {clicked:true,stopRequestedAt:123};}return {};};
    pollOnePending=async()=>{await clearRecoveredTask('task','session',7);};
    httpJson=async(method,url,body)=>{
      if(url.endsWith('/claim')) return {command};
      if(url.endsWith('/fence')) {
        command.state='executing'; command.result={beforeDocumentId:body.documentId,submittedUserMessageId:body.submittedUserMessageId};
        return {execute:true,result:command.result};
      }
      if(url.endsWith('/finish')) {outcome=body;throw new Error('connection lost before finish persisted');}
      return {taskId:'task',session:'session',status:'cancelled',error:'user stopped before reply'};
    };
    await processSessionControls();
    return {command,clicks,outcome,pending:await getPendingReply('task')};
  })()`,w.context);
  assert.equal(evidence.clicks,1);
  assert.equal(evidence.pending,null);
  assert.equal(evidence.outcome.state,'succeeded');
  const restarted=await worker();
  restarted.context.command=JSON.parse(JSON.stringify(evidence.command));
  const result=await vm.runInContext(`(async()=>{
    let outcome;
    getTabSession=async()=> 'session';
    getPageState=async()=>({session:'session',documentId:'doc',ready:true,generating:false,baseline:{lastUserId:'user'}});
    sendTabMessage=async()=>{throw new Error('must not click Stop again');};
    httpJson=async(method,url,body)=>{
      if(url.endsWith('/claim')) return {command};
      if(url.endsWith('/finish')) {outcome=body;return {};}
      if(method!=='GET') throw new Error('must not fence again');
      return {taskId:'task',session:'session',status:'cancelled',error:'user stopped before reply'};
    };
    await processSessionControls();
    return outcome;
  })()`,restarted.context);
  assert.equal(result.state,'succeeded');
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)),JSON.parse(JSON.stringify(evidence.outcome.result)));
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

for (const timing of ["preclaim", "postclaim", "run-task"]) {
  test(`dispatch waits for a dirty composer: ${timing}`, async () => {
    const w = await worker("opening", true);
    w.context.draftTiming = timing;
    const calls = await vm.runInContext(`(async () => {
      const calls=[]; let pages=0;
      tabSessionCache.set(7,'session');
      getPageState=async()=>({session:'session',ready:true,generating:false,baseline:{},
        composerClean: ++pages !== (draftTiming==='preclaim'?1:draftTiming==='postclaim'?2:0)});
      httpJson=async(method,path)=>{
        calls.push(path);
        return path.startsWith('/internal/next_task')?{task:{taskId:'task',text:'prompt'}}:{};
      };
      sendTabMessage=async(tab,msg)=>{
        calls.push(msg.type);
        return msg.type==='run-task'?{error:'existing draft',errorCode:'composer_not_clean',submissionState:'not-submitted'}:{};
      };
      setTimeout=(fn)=>{stopDispatchLoop('session'); fn(); return 1;};
      await startDispatchLoop('session',7);
      return calls;
    })()`, w.context);
    assert.equal(calls.some((x: string) => x.startsWith('/internal/next_task')), timing !== 'preclaim');
    assert.equal(calls.includes('run-task'), timing === 'run-task');
    assert.equal(calls.includes('/internal/tasks/task/defer'), timing !== 'preclaim');
    assert.equal(calls.includes('/internal/tasks/task/complete'), false);
  });
}

for (const scenario of ['owned','foreign-owner','foreign-tab','foreign-project','bound','hydrating','other-first-task',
  'cancelled','prior-send','edited-after-claim'] as const) {
  test(`only an owned unsent first task can initialize a dirty new page: ${scenario}`, async () => {
    const w = await worker('opening', true);
    w.context.initializationScenario = scenario;
    const result = await vm.runInContext(`(async()=>{
      const scenario=initializationScenario,calls=[];
      let claimed=false,run=null;
      const managed={sessionRef:'sr_new',owner:scenario==='foreign-owner'?'other':'browser',
        token:'token',initialTaskId:'task',projectId:scenario==='foreign-project'?'g-p-'+'a'.repeat(32):null};
      getPageState=async()=>({session:'sr_new',documentId:'doc',ready:false,observationReady:scenario!=='hydrating',
        generating:false,composerClean:false,baseline:{},reason:'composer-not-clean',
        initialCreation:claimed&&scenario==='edited-after-claim'?null:managed});
      httpJson=async(method,path)=>{
        calls.push(path);
        if(path.endsWith('/inspect'))return {tabId:scenario==='foreign-tab'?8:7,conversationId:null,projectId:null,
          creationStatus:scenario==='bound'?'created':'pending',initialTaskId:'task',
          initialTaskStatus:claimed?'in_progress':'queued'};
        if(path.startsWith('/internal/next_task')){claimed=true;return {task:{taskId:scenario==='other-first-task'?'other':'task',text:'new prompt'}};}
        if(path==='/v1/tasks/task')return {status:scenario==='cancelled'?'cancelled':'in_progress',
          sendAttemptedAt:scenario==='prior-send'?123:null};
        if(path.endsWith('/complete')||path.endsWith('/defer'))stopDispatchLoop('sr_new');
        return {};
      };
      sendTabMessage=async(tab,msg)=>{
        if(msg.type==='run-task'){
          run=msg;calls.push('run-task');
          return {error:'initialization failed',errorCode:'new_session_initialization_failed',submissionState:'not-submitted'};
        }
        return {};
      };
      setTimeout=fn=>{stopDispatchLoop('sr_new');fn();return 1;};
      await startDispatchLoop('sr_new',7);
      return {calls,run};
    })()`, w.context);
    if (scenario === 'owned') {
      assert.deepEqual(JSON.parse(JSON.stringify(result.run.initializeComposer)), {token:'token',documentId:'doc'});
      assert.ok(result.calls.indexOf('/v1/tasks/task') < result.calls.indexOf('run-task'));
      assert.ok(result.calls.some((p: string) => p.endsWith('/complete')));
      assert.ok(!result.calls.some((p: string) => p.endsWith('/defer')), 'initialization failure must not spin forever');
    } else {
      assert.equal(result.run, null);
    }
    if (['foreign-owner','foreign-tab','foreign-project','bound','hydrating'].includes(scenario)) {
      assert.ok(!result.calls.some((p: string) => p.startsWith('/internal/next_task')));
    }
  });
}

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
  await vm.runInContext("markInflight('session','new-task',{tabId:7,deliveryPhase:'preparing'})",w.context);
  await vm.runInContext("releaseTaskRead({taskId:'old-task',status:'done'}); reconciliation;",w.context);
  assert.equal(w.storage.inflight.session?.taskId,'new-task');
  const cleared = w.context.events.find((e:any)=>e.type==='clear-inflight');
  assert.equal(cleared.taskId,'old-task');
  assert.equal(cleared.expectedSession,'session');
});

for (const source of ['page', 'reconcile', 'control', 'send-fence']) {
  for (const replacement of ['cleared', 'successor', 'same-task-reclaimed']) {
    test(`late ${source} cannot resurrect ownership after ${replacement}`, async () => {
      const w = await worker('opening', true);
      w.context.recoverySource = source;
      w.context.replacement = replacement;
      const result = await vm.runInContext(`(async () => {
        tabSessionCache.set(7,'session');
        getTabSession=async()=> 'session';
        startDispatchLoop=async()=>{}; pollPendingReplies=async()=>{}; sendTabMessage=async()=>({});
        const old={taskId:'old',session:'session',status:'in_progress',sendAttemptedAt:1,submitAcknowledgedAt:2};
        const record={tabId:7,baseline:{lastUserId:'before-old'},deliveryPhase:'accepted',submittedUserMessageId:'old-user'};
        await markInflight('session','old',record);
        await setPendingReply('old',{...record,session:'session',taskId:'old'});
        let release, started;
        const read=new Promise(resolve=>release=resolve), reading=new Promise(resolve=>started=resolve);
        let reads=0;
        httpJson=async(method,url)=>{
          if (method==='GET' && url==='/v1/tasks/old') {
            reads++;
            if (recoverySource!=='send-fence' || reads===2) {started(); return read;}
            return old;
          }
          return {};
        };
        const operation = recoverySource==='page'?recoverInflightForTab({...record,taskId:'old'},7):
          recoverySource==='reconcile'?reconcileInflight():
          recoverySource==='control'?executeSessionControl({kind:'recover',session:'session',taskId:'old',tabId:7}):
          null; // The message bridge is started by the test host below.
        if (recoverySource==='send-fence') return {started,reading,release,old};
        const outcome=operation.catch(e=>({error:e.message}));
        await reading;
        await clearRecoveredTask('old','session',7);
        if (replacement!=='cleared') {
          const id=replacement==='successor'?'successor':'old';
          await markInflight('session',id,{tabId:7,deliveryPhase:'preparing'});
          await markInflight('session',id,{deliveryPhase:'send-attempted',sendAttemptedAt:123,submittedUserMessageId:'new-user'});
        }
        const before=await getInflight('session');
        release(old);
        return {before,after:await outcome,final:await getInflight('session'),pending:await listPendingReplies()};
      })()`, w.context);
      let checked = result;
      if (source === 'send-fence') {
        const operation = w.message({type:'send-attempted',taskId:'old',baseline:{lastUserId:'before-old'}});
        await result.reading;
        await vm.runInContext(`(async()=>{
          await clearRecoveredTask('old','session',7);
          if(replacement!=='cleared') {
            const id=replacement==='successor'?'successor':'old';
            await markInflight('session',id,{tabId:7,deliveryPhase:'preparing'});
            await markInflight('session',id,{deliveryPhase:'send-attempted',sendAttemptedAt:123,submittedUserMessageId:'new-user'});
          }
        })()`,w.context);
        const before = await vm.runInContext("getInflight('session')", w.context);
        result.release(result.old);
        checked = {before, after:await operation, final:await vm.runInContext("getInflight('session')",w.context),
          pending:await vm.runInContext('listPendingReplies()',w.context)};
      }
      assert.deepEqual(checked.final, checked.before);
      assert.equal(Object.keys(checked.pending).length, 0);
      assert.notEqual(checked.after?.action, 'reattached');
      assert.notEqual(checked.after?.action, 'observation_attached');
      assert.notEqual(checked.after?.status, 'fenced');
      if (replacement !== 'cleared') assert.equal(checked.final.sendAttemptedAt,123);
    });
  }
}

test('recovery commits both records atomically, preserves evidence, and ignores unrelated sessions', async () => {
  const w = await worker();
  const result = await vm.runInContext(`(async()=>{
    const task={taskId:'task',session:'session',status:'in_progress',sendAttemptedAt:1};
    await markInflight('session','task',{deliveryPhase:'accepted',sendAttemptedAt:123,submittedUserMessageId:'sent-user'});
    await setPendingReply('task',{session:'session',tabId:7,baseline:{lastUserId:'baseline'},
      deliveryPhase:'accepted',submittedUserMessageId:'sent-user',stopRequestedAt:50});
    const epochs=await captureTaskEpochs();
    await markInflight('other-session','other-task',{deliveryPhase:'preparing'});
    const writes=[]; const originalSet=chrome.storage.local.set;
    chrome.storage.local.set=async values=>{writes.push(Object.keys(values)); return originalSet(values);};
    const attached=await attachPendingFromTask(task,'session',7,{deliveryPhase:'send-attempted',baseline:{}},epochs);
    return {attached,writes,inflight:await getInflight('session'),pending:await getPendingReply('task')};
  })()`,w.context);
  assert.equal(result.attached,true);
  assert.equal(result.writes.length,1);
  assert.deepEqual(Array.from(result.writes[0]).sort(),['inflight','pending_replies']);
  assert.equal(result.inflight.sendAttemptedAt,123);
  assert.equal(result.inflight.deliveryPhase,'accepted');
  assert.equal(result.inflight.submittedUserMessageId,'sent-user');
  assert.equal(result.pending.stopRequestedAt,50);
  assert.equal(result.pending.baseline.lastUserId,'baseline');
});

test('late sampler writes cannot restore a retired task or displace another owner',async()=>{
  const w=await worker();
  const result=await vm.runInContext(`(async()=>{
    sendTabMessage=async()=>({});
    await markInflight('session','old',{deliveryPhase:'accepted'});
    const rec={taskId:'old',session:'session',tabId:7};
    await setPendingReply('old',rec);
    await clearRecoveredTask('old','session',7);
    const retired=await setPendingReply('old',rec);
    await markInflight('session','new',{deliveryPhase:'preparing'});
    const displaced=await setPendingReply('unknown',rec);
    const marked=await markInflight('session','old',{deliveryPhase:'send-attempted'});
    return {retired,displaced,marked,pending:await listPendingReplies(),inflight:await getInflight('session')};
  })()`,w.context);
  assert.equal(result.retired,false);
  assert.equal(result.displaced,false);
  assert.equal(result.marked,false);
  assert.equal(Object.keys(result.pending).length,0);
  assert.equal(result.inflight.taskId,'new');
});

for (const writer of ['sampler', 'submission-ack']) {
  test(`late ${writer} preserves learned identity through recovery, refresh and Stop`, async () => {
    const w=await worker();
    w.context.lateWriter=writer;
    const result=await vm.runInContext(`(async()=>{
      const task={taskId:'task',session:'session',status:'in_progress',sendAttemptedAt:10,submitAcknowledgedAt:20};
      const early={taskId:'task',session:'session',tabId:7,baseline:{lastUserId:'previous'},
        deliveryPhase:'send-attempted',sendAttemptedAt:10,submittedUserMessageId:null,wasGenerating:false};
      await markInflight('session','task',early);
      await setPendingReply('task',early);
      const late=await getPendingReply('task');
      await setPendingReply('task',{...early,deliveryPhase:'accepted',wasGenerating:true,submissionAcknowledged:true,
        submittedUserMessageId:'original-user',submitAcknowledgedProgressReported:true});
      const epochs=await captureTaskEpochs();
      await attachPendingFromTask(task,'session',7,await getPendingReply('task'),epochs);
      if(lateWriter==='sampler') await setPendingReply('task',late);
      else {
        await markInflight('session','task',{deliveryPhase:'accepted',submittedUserMessageId:null});
        await setClaimPendingReply({task},'session',7,early.baseline,'accepted',{submittedUserMessageId:null});
      }
      const pending=await getPendingReply('task'), inflight=await getInflight('session');
      let documentId='before', stopping=false;
      getTabSession=async()=> 'session';
      getPageState=async()=>({session:'session',ready:true,generating:false,composerClean:true,documentId,
        baseline:{lastUserId:'original-user',userCount:1}});
      pollOnePending=async()=>{}; pollPendingReplies=async()=>{};
      httpJson=async(method,url,body)=>url.endsWith('/fence')?{execute:true,result:{beforeDocumentId:body.documentId}}:
        {...task,status:stopping?'cancelled':'in_progress'};
      sendTabMessage=async(tab,msg)=>{
        if(msg.type==='refresh-page') {documentId='after';return {reloading:true};}
        stopping=true;
        return {clicked:msg.submittedUserMessageId==='original-user',stopRequestedAt:123};
      };
      const refreshed=await executeRefreshControl({kind:'refresh',state:'claimed',session:'session',taskId:'task',tabId:7,expiresAt:Date.now()+1000});
      const stopped=await executeStopControl({kind:'stop',state:'claimed',session:'session',taskId:'task',tabId:7,expiresAt:Date.now()-1});
      return {pending,inflight,refreshed,stopped};
    })()`,w.context);
    assert.equal(result.pending.submittedUserMessageId,'original-user');
    assert.equal(result.inflight.submittedUserMessageId,'original-user');
    assert.equal(result.pending.wasGenerating,true);
    assert.equal(result.pending.deliveryPhase,'accepted');
    assert.equal(result.pending.submissionAcknowledged,true);
    assert.equal(result.refreshed.action,'page_refreshed');
    assert.equal(result.stopped.stopRequested,true);
  });
}

test('same-task evidence survives stale snapshots and rejects conflicting message identities',async()=>{
  const w=await worker();
  const result=await vm.runInContext(`(async()=>{
    await markInflight('session','task',{tabId:7,baseline:{lastUserId:'previous'},deliveryPhase:'send-attempted',sendAttemptedAt:10});
    await setPendingReply('task',{session:'session',tabId:7,submittedUserMessageId:'original-user',
      deliveryPhase:'accepted',wasGenerating:true,submissionAcknowledged:true,stopRequestedAt:20});
    const learned=await getInflight('session');
    await setPendingReply('task',{session:'session',tabId:7,baseline:{lastUserId:'wrong'},submittedUserMessageId:null,
      deliveryPhase:'send-attempted',sendAttemptedAt:99,wasGenerating:false,submissionAcknowledged:false,stopRequestedAt:null});
    const pending=await getPendingReply('task');
    const conflict=await setPendingReply('task',{session:'session',tabId:7,submittedUserMessageId:'other-user'});
    const ownerConflict=await markInflight('session','task',{submittedUserMessageId:'other-user'});
    return {learned,pending,conflict,ownerConflict,final:await getPendingReply('task')};
  })()`,w.context);
  assert.equal(result.learned.submittedUserMessageId,'original-user','sampling alone persists recovery identity');
  assert.equal(result.pending.baseline.lastUserId,'previous');
  assert.equal(result.pending.sendAttemptedAt,10);
  assert.equal(result.pending.stopRequestedAt,20);
  assert.equal(result.pending.wasGenerating,true);
  assert.equal(result.pending.submissionAcknowledged,true);
  assert.equal(result.conflict,false);
  assert.equal(result.ownerConflict,false);
  assert.deepEqual(result.final,result.pending);
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
