// Synthetic MV3 transport test. Run: node --import tsx scripts/test-browser-dispatch.mjs
// Uses a fresh temporary profile, local fixture pages and a temporary relay DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const edgeBin = process.env.RELAY_TEST_EDGE_BIN || (process.platform === 'darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : null);
if (!edgeBin || !fs.existsSync(edgeBin))
    throw new Error('Set RELAY_TEST_EDGE_BIN to an installed Edge executable.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dispatch-browser-e2e.'));
const ext = path.join(root, 'extension');
fs.cpSync(path.join(repoRoot, 'extension'), ext, { recursive: true });
const metrics = { watch: 0, watchActive: 0, maxWatch: 0, maxOverlapMs: 0, next: 0, claims: 0, fences: 0, captures: 0, sends: {}, errors: [] };
const handle = createApp({ ...loadConfig(), dbFile: path.join(root, 'test.db'), maintenanceIntervalMs: 1000 });
// Instrument Express before its existing router stack.
handle.app.use((req, res, next) => { if (req.path === '/internal/dispatch/watch') {
    metrics.watch++;
    metrics.watchActive++;
    metrics.maxWatch = Math.max(metrics.maxWatch, metrics.watchActive);
    if (metrics.watchActive === 2)
        metrics.overlapStarted = Date.now();
    res.once('close', () => { if (metrics.watchActive === 2) {
        metrics.maxOverlapMs = Math.max(metrics.maxOverlapMs, Date.now() - metrics.overlapStarted);
        delete metrics.overlapStarted;
    } metrics.watchActive--; });
} if (req.path === '/internal/next_task')
    metrics.next++; if (req.path === '/internal/dispatch/claim')
    metrics.claims++; if (req.path.endsWith('/capture'))
    metrics.captures++; if (req.path.endsWith('/progress'))
    metrics.fences++; res.once('finish', () => { if (res.statusCode >= 400)
    metrics.errors.push([req.path, res.statusCode]); }); next(); });
handle.app._router.stack.splice(2, 0, handle.app._router.stack.pop());
handle.app.get('/c/:id', (_req, res) => res.type('html').send('<html><body>Local synthetic relay fixture</body></html>'));
handle.app.get('/fixture-send/:id', (req, res) => { metrics.sends[req.params.id] = (metrics.sends[req.params.id] ?? 0) + 1; res.json({ ok: true }); });
let server = handle.app.listen(0, '127.0.0.1');
await new Promise((r, j) => { server.once('listening', r); server.once('error', j); });
const port = server.address().port, base = `http://127.0.0.1:${port}`;
let worker = fs.readFileSync(path.join(ext, 'service-worker.js'), 'utf8').replaceAll('https://chatgpt.com/*', base + '/*');
worker += '\nglobalThis.__fixtureStart=()=>{dispatchMode=null;return ensureDispatch()};';
fs.writeFileSync(path.join(ext, 'service-worker.js'), worker);
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
manifest.content_scripts = [{ matches: ['http://127.0.0.1/*'], js: ['fixture.js'], run_at: 'document_idle' }];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest));
fs.writeFileSync(path.join(ext, 'fixture.js'), `const session=location.pathname.split('/').pop(),documentId=crypto.randomUUID();let running=null;const metadata=()=>({session,conversationId:session,projectId:null,documentId});const state=()=>({...metadata(),ready:true,reason:null,stableForMs:10000,composerClean:true,generating:false,observationReady:true,controlProtocol:1,dispatchProtocol:2,baseline:{userCount:0,assistantCount:0},capabilities:{composer:true,userMessages:true}});chrome.runtime.onMessage.addListener((msg,sender,reply)=>{if(msg.type==='get-session-id')reply(metadata());else if(msg.type==='get-page-state')reply(state());else if(msg.type==='get-inflight')reply({inflight:running});else if(msg.type==='poll-reply'&&sessionStorage.getItem('fixtureHold'))reply({status:'generating',submittedUserMessageId:'u-'+msg.taskId});else if(msg.type==='poll-reply')reply({status:'reply-ready',reply:'synthetic reply '+msg.taskId,submittedUserMessageId:'u-'+msg.taskId,assistantMessageId:'a-'+msg.taskId});else if(msg.type==='run-task'){(async()=>{const fence=await chrome.runtime.sendMessage({type:'send-attempted',taskId:msg.taskId,documentId,claimToken:msg.claimToken,baseline:msg.baseline});if(fence.error){reply({error:fence.error,submissionState:'unknown'});return}await fetch('/fixture-send/'+msg.taskId);running={taskId:msg.taskId,claimToken:msg.claimToken};reply({status:'submitted',submittedUserMessageId:'u-'+msg.taskId,baseline:msg.baseline})})().catch(e=>reply({error:e.message}));return true}else if(msg.type==='clear-inflight'){running=null;reply({ok:true})}else reply({safe:true,...state()});return false});setInterval(()=>chrome.runtime.sendMessage({type:'session-hello',...metadata()}).catch(()=>{}),3000);chrome.runtime.sendMessage({type:'session-hello',...metadata()}).catch(()=>{});`);
const proc = spawn(edgeBin, ['--headless=new', '--no-first-run', '--disable-sync', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-features=MediaRouter', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${root}/profile`, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
proc.stderr.on('data', b => { stderr += b.toString(); });
const delay = ms => new Promise(r => setTimeout(r, ms));
let ws;
let nextId = 0;
const pending = new Map();
const events = [];
async function command(method, params = {}, sessionId) { const id = ++nextId; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 10000); pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); }
function queueLatency(tasks) {
    const values = tasks.map(task => handle.store.getTask(task.id))
        .filter(task => task?.dispatchedAt != null)
        .map(task => task.dispatchedAt - task.submittedAt).sort((a, b) => a - b);
    if (!values.length) return { count: 0 };
    return { count: values.length, min: values[0], median: values[Math.floor(values.length / 2)],
        max: values.at(-1), mean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) };
}
function report(value) {
    const reportPath = path.join(root, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify({ ...value, reportPath }, null, 2) + '\n');
    console.log(JSON.stringify({ ...value, reportPath }, null, 2));
}
async function attach(targetId) { return (await command('Target.attachToTarget', { targetId, flatten: true })).sessionId; }
async function evaluate(sessionId, expression) { const v = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (v.exceptionDetails)
    throw new Error(JSON.stringify(v.exceptionDetails)); return v.result.value; }
try {
    let debug;
    for (let n = 0; n < 100; n++) {
        const f = path.join(root, 'profile/DevToolsActivePort');
        if (fs.existsSync(f)) {
            const [p, endpoint] = fs.readFileSync(f, 'utf8').trim().split('\n');
            debug = `ws://127.0.0.1:${p}${endpoint}`;
            break;
        }
        await delay(100);
    }
    if (!debug)
        throw new Error('No Edge DevTools endpoint: ' + stderr.slice(-1200));
    ws = new WebSocket(debug);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error)
            p?.reject(new Error(JSON.stringify(m.error)));
        else
            p?.resolve(m.result);
    }
    else
        events.push(m); });
    let sw;
    for (let n = 0; n < 50; n++) {
        sw = (await command('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.endsWith('/service-worker.js'));
        if (sw)
            break;
        await delay(100);
    }
    if (!sw)
        throw new Error('MV3 service worker unavailable ' + JSON.stringify((await command('Target.getTargets')).targetInfos));
    console.log('SW_TARGET', JSON.stringify(sw));
    let sid = await attach(sw.targetId);
    await command('Runtime.enable', {}, sid);
    for (let n = 0; n < 50; n++) {
        if (await evaluate(sid, 'typeof chrome!=="undefined" && !!chrome.storage'))
            break;
        await delay(100);
    }
    await evaluate(sid, `chrome.storage.local.set({config:{baseUrl:${JSON.stringify(base)},maxManagedTabs:30}})`);
    await evaluate(sid, 'globalThis.__fixtureStart()');
    const sessions = Array.from({ length: 12 }, () => randomUUID());
    for (const session of sessions)
        await command('Target.createTarget', { url: base + '/c/' + session });
    await command('Target.detachFromTarget', { sessionId: sid });
    const tasks = sessions.map(session => handle.store.createTask({ session, text: 'synthetic transport ' + session }));
    async function waitDone(ids, ms = 45000) { for (let n = 0; n < ms / 250; n++) {
        if (ids.every(id => handle.store.getTask(id).status === 'done'))
            return;
        await delay(250);
    } throw new Error('tasks not complete ' + JSON.stringify(ids.map(id => ({ id, status: handle.store.getTask(id).status })))); }
    await waitDone(tasks.map(t => t.id));
    // Force worker stop via DevTools, then detach before observing restart. This
    // demonstrates forced-stop recovery, not the browser's natural idle timeout.
    const browserTarget = (await command('Target.getTargets')).targetInfos.find(t => t.type === 'page');
    const pageSession = await attach(browserTarget.targetId);
    await command('ServiceWorker.enable', {}, pageSession);
    await delay(100);
    const versions = events.filter(e => e.method === 'ServiceWorker.workerVersionUpdated').flatMap(e => e.params.versions);
    const version = versions.reverse().find(v => v.scriptURL === sw.url && v.status === 'activated');
    if (!version)
        throw new Error('No SW version for forced stop');
    await command('ServiceWorker.stopWorker', { versionId: version.versionId }, pageSession);
    await command('Target.detachFromTarget', { sessionId: pageSession });
    const after = handle.store.createTask({ session: sessions[0], text: 'after forced worker stop' });
    await waitDone([after.id]);
    // Disconnect after the durable Send fence while the fixture is generating.
    const heldTarget = (await command('Target.getTargets')).targetInfos.find(t => t.url === base + '/c/' + sessions[1]);
    const heldSession = await attach(heldTarget.targetId);
    await evaluate(heldSession, "sessionStorage.setItem('fixtureHold','yes')");
    await command('Target.detachFromTarget', { sessionId: heldSession });
    const offline = handle.store.createTask({ session: sessions[1], text: 'active during backend disconnect' });
    for (let n = 0; n < 120 && !metrics.sends[offline.id]; n++)
        await delay(250);
    if (!metrics.sends[offline.id])
        throw new Error('held task never reached Send');
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await delay(1500);
    server = handle.app.listen(port, '127.0.0.1');
    await new Promise((r, j) => { server.once('listening', r); server.once('error', j); });
    const restoredSession = await attach(heldTarget.targetId);
    await evaluate(restoredSession, "sessionStorage.removeItem('fixtureHold')");
    await command('Target.detachFromTarget', { sessionId: restoredSession });
    await waitDone([offline.id]);
    if (metrics.maxWatch > 2 || metrics.maxOverlapMs > 500 || metrics.next || Object.values(metrics.sends).some(n => n !== 1))
        throw new Error('transport invariants failed');
    report({ result: 'PASS', root, base, sessionCount: sessions.length, tasks: tasks.length + 2, queueClaimLatencyMs: { coldPages: queueLatency(tasks), restartedWorker: queueLatency([after]), backendDisconnectAfterSend: queueLatency([offline]) }, metrics, forcedStop: true, naturalIdleTested: false });
}
catch (e) {
    report({ result: 'FAIL', root, base, error: e.stack, metrics, stderr: stderr.slice(-2000) });
    process.exitCode = 1;
}
finally {
    ws?.close();
    proc.kill('SIGTERM');
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    handle.stopMaintenance();
    handle.closeDatabase();
}
