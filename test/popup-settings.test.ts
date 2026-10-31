import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { Window } from "happy-dom";

async function harness() {
  const window = new Window();
  window.document.write(fs.readFileSync(new URL("../extension/popup.html", import.meta.url), "utf8"));
  const messages: any[] = [];
  const state: any = {baseUrl:"http://localhost:8765",dispatch:{state:"disconnected",lastError:"network_error"},
    capacity:{managedCount:1,maxManagedTabs:6,available:5,waiting:["waiting-session"]},inflight:{},
    tabs:[{tabId:1,session:null,pageKind:"home"},{tabId:2,session:"manual",lifecyclePolicy:"protected"}]};
  let rejectSettings = false;
  const context = vm.createContext({document:window.document,console,Date,setTimeout:()=>0,setInterval:()=>0,
    chrome:{runtime:{sendMessage:async (message: any)=>{
      messages.push(message);
      if(message.type==="popup-get-state") return state;
      if(rejectSettings) return {error:"settings_rejected"};
      if(message.type==="popup-set-capacity") state.capacity.maxManagedTabs=message.maxManagedTabs;
      if(message.type==="popup-set-page-policy") state.tabs.find((t:any)=>t.tabId===message.tabId).lifecyclePolicy=message.lifecyclePolicy;
      return {ok:true};
    }}},fetch:async (url:string)=>({json:async()=>url.endsWith("/health")?{status:"ok"}:url.includes("/tasks")?{tasks:[]}:{sessions:[]}})});
  vm.runInContext(fs.readFileSync(new URL("../extension/popup.js", import.meta.url), "utf8"),context);
  const settle = async()=>{ await new Promise<void>(resolve => setImmediate(resolve)); };
  await settle();
  return {window,messages,state,settle,reject:()=>{rejectSettings=true;}};
}

test("popup presents discovery and dispatch separately and validates managed capacity",async()=>{
  const h=await harness();
  try {
    const doc=h.window.document;
    assert.match(doc.getElementById("dispatchStatus")!.textContent,/disconnected.*network_error/);
    assert.match(doc.getElementById("sessions")!.textContent,/discovery \(home\)/);
    assert.doesNotMatch(doc.getElementById("sessions")!.textContent,/script unavailable/);
    assert.equal((doc.querySelector("select") as any).disabled,true);
    assert.equal(h.messages.filter(m=>m.type==="popup-set-page-policy").length,0);
    for(const value of ["0","101","1.5",""]) {
      (doc.getElementById("maxManagedTabs") as any).value=value;
      (doc.getElementById("saveCapacity") as any).click(); await h.settle();
    }
    assert.equal(h.messages.filter(m=>m.type==="popup-set-capacity").length,0);
    (doc.getElementById("maxManagedTabs") as any).value="8";
    (doc.getElementById("saveCapacity") as any).click(); await h.settle();
    assert.equal(h.state.capacity.maxManagedTabs,8);
    assert.match(doc.getElementById("capacityStatus")!.textContent,/1\/8/);
  } finally {await h.window.happyDOM.close();}
});

test("manual page reclaim permission is explicit and rejected updates surface errors",async()=>{
  const h=await harness();
  try {
    const doc=h.window.document;
    const select=doc.querySelectorAll("select")[1] as any;
    assert.equal(select.value,"protected");
    select.value="reclaimable";
    select.dispatchEvent(new h.window.Event("change")); await h.settle();
    const message=h.messages.find(m=>m.type==="popup-set-page-policy");
    assert.equal(message.tabId,2);
    assert.equal(message.lifecyclePolicy,"reclaimable");
    h.reject();
    (doc.getElementById("maxManagedTabs") as any).value="9";
    (doc.getElementById("saveCapacity") as any).click(); await h.settle();
    assert.equal((doc.getElementById("actionError") as any).hidden,false);
    assert.equal(doc.getElementById("actionError")!.textContent,"settings_rejected");
  } finally {await h.window.happyDOM.close();}
});
