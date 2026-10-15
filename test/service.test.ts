import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { installationPlan, parseServiceArgs } from "../service/index.js";
import { MacOSService, SERVICE_LABEL, renderPlist, assertPortAvailable, type ServicePlan } from "../service/macos.js";

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-service-"));
  const plan: ServicePlan = { node: path.join(home, "node"), loader: "file:///test/tsx.mjs", root: path.join(home, "package"),
    logDir: path.join(home, "logs"), environment: { GPT_RELAY_HOST: "0.0.0.0", GPT_RELAY_PORT: "8765", GPT_RELAY_DATA_DIR: home } };
  let loaded = false, failBootstrap = false, failPrint = false, failBootout = false, occupied = false, delayedRelease = 0;
  let unloadDelay = 0, unloadingReads = 0;
  const commands: string[][] = [];
  const config = { Label: SERVICE_LABEL, EnvironmentVariables: plan.environment,
    StandardOutPath: path.join(plan.logDir, "launchd.stdout.log"), StandardErrorPath: path.join(plan.logDir, "launchd.stderr.log") };
  const service = new MacOSService(home, 501, (command, args) => {
    commands.push([command, ...args]);
    if (args[0] === "print" && unloadingReads > 0 && --unloadingReads === 0) loaded = false;
    if (args[0] === "print") return failPrint
      ? { status: 1, stdout: "", stderr: "Operation not permitted" }
      : loaded ? { status: 0, stdout: "state = running\n\tpid = 12345\n", stderr: "" }
        : { status: 113, stdout: "", stderr: "Could not find service in domain for user gui: 501" };
    if (args[0] === "-convert") return { status: 0, stdout: JSON.stringify(config), stderr: "" };
    if (args[0] === "bootstrap") {
      loaded = true;
      if (failBootstrap) return { status: 5, stdout: "", stderr: "Bootstrap failed" };
    }
    if (args[0] === "bootout") {
      if (failBootout) return { status: 1, stdout: "", stderr: "Bootout failed" };
      unloadingReads = unloadDelay;
      if (!unloadingReads) loaded = false;
    }
    return { status: 0, stdout: "", stderr: "" };
  }, async () => {
    if (occupied) throw new Error("port occupied");
    if (delayedRelease-- > 0) throw new Error("socket closing", { cause: Object.assign(new Error(), { code: "EADDRINUSE" }) });
  });
  return { home, plan, service, commands, config,
    occupy() { occupied = true; }, failBootstrap() { failBootstrap = true; }, failPrint() { failPrint = true; },
    failBootout() { failBootout = true; }, delayRelease() { delayedRelease = 1; },
    delayUnload() { unloadDelay = 3; },
    clean() { fs.rmSync(home, { recursive: true, force: true }); } };
}

test("service options reject ambiguity before invoking an OS adapter", () => {
  for (const action of ["install", "status", "start", "stop", "restart", "uninstall"]) {
    assert.deepEqual(parseServiceArgs([action]), { action, dryRun: false });
  }
  assert.deepEqual(parseServiceArgs(["install", "--dry-run"]), { action: "install", dryRun: true });
  for (const args of [[], ["unknown"], ["status", "--dry-run"], ["install", "--dry-run", "--dry-run"], ["install", "--host", "0.0.0.0"]]) {
    assert.throws(() => parseServiceArgs(args), /usage:/);
  }
});

test("installation resolves runtime paths and captures server configuration without credentials or backend binding", () => {
  const saved = { ...process.env };
  try {
    process.env.GPT_RELAY_HOST = "0.0.0.0";
    process.env.GPT_RELAY_PORT = "9123";
    process.env.GPT_RELAY_DATA_DIR = "./service-data";
    process.env.GPT_RELAY_DISCOVERY = "0";
    process.env.GPT_RELAY_DEFAULT_TIMEOUT_MS = "12345";
    process.env.GPT_RELAY_URL = "http://remote.invalid:8765";
    process.env.TEST_CREDENTIAL = "must-not-be-copied";
    delete process.env.GPT_RELAY_DB_FILE;
    delete process.env.GPT_RELAY_LOG_DIR;
    const plan = installationPlan();
    assert.equal(plan.node, fs.realpathSync(process.execPath));
    assert.equal(plan.loader, "tsx");
    assert.equal(plan.environment.GPT_RELAY_PORT, "9123");
    assert.equal(plan.environment.GPT_RELAY_HOST, "0.0.0.0");
    assert.equal(plan.environment.GPT_RELAY_DB_FILE, path.resolve("service-data/gpt-relay.db"));
    assert.equal(plan.environment.GPT_RELAY_DISCOVERY, "0");
    assert.equal(plan.environment.GPT_RELAY_DEFAULT_TIMEOUT_MS, "12345");
    assert.equal(plan.environment.GPT_RELAY_URL, undefined);
    assert.equal(plan.environment.TEST_CREDENTIAL, undefined);
    for (const port of ["0", "65536", "1.5", "invalid"]) {
      process.env.GPT_RELAY_PORT = port;
      assert.throws(installationPlan, /fixed GPT_RELAY_PORT/);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("LaunchAgent configuration escapes paths and uses one directly managed server process", () => {
  const f = fixture();
  try {
    f.plan.root += "/space & <tag> 'quote'";
    const plist = renderPlist(f.plan);
    assert.ok(plist.includes("space &amp; &lt;tag&gt; &apos;quote&apos;"));
    assert.ok(plist.includes("<key>KeepAlive</key><true/>"));
    assert.ok(plist.includes("<key>ExitTimeOut</key><integer>30</integer>"));
    assert.ok(plist.includes("index.ts"));
    assert.ok(!plist.includes("gpt-relay.mjs"));
    if (process.platform === "darwin") {
      const file = path.join(f.home, "validate.plist");
      fs.writeFileSync(file, plist);
      const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const config = JSON.parse(result.stdout);
      assert.deepEqual(config.ProgramArguments, [f.plan.node, "--import", f.plan.loader, path.join(f.plan.root, "server", "index.ts")]);
      assert.equal(config.WorkingDirectory, f.plan.root);
    }
  } finally { f.clean(); }
});

test("dry run performs no OS or filesystem mutation", async () => {
  const f = fixture();
  try {
    const result = await f.service.install(f.plan, true);
    assert.equal(result.plist, f.service.file);
    assert.equal(f.commands.length, 0);
    assert.equal(fs.existsSync(path.dirname(f.service.file)), false);
    assert.equal(fs.existsSync(f.plan.logDir), false);
  } finally { f.clean(); }
});

test("install, stop, start, graceful restart and uninstall preserve data and logs", async () => {
  const f = fixture();
  try {
    const data = path.join(f.home, "gpt-relay.db");
    fs.writeFileSync(data, "existing database");
    const installed = await f.service.install(f.plan);
    assert.ok("running" in installed);
    assert.equal(installed.running, true);
    assert.equal(installed.pid, 12345);
    if (process.platform !== "win32") assert.equal(fs.statSync(f.service.file).mode & 0o777, 0o600);
    assert.equal((await f.service.stop()).loaded, false);
    assert.equal(fs.existsSync(f.service.file), true);
    assert.equal((await f.service.start()).running, true);
    const before = f.commands.length;
    f.delayRelease();
    f.delayUnload();
    assert.equal((await f.service.restart()).running, true);
    const commands = f.commands.slice(before).filter(c => ["bootout", "bootstrap"].includes(c[1]!));
    assert.deepEqual(commands.map(c => c[1]), ["bootout", "bootstrap"]);
    assert.ok(!f.commands.some(c => c.includes("kickstart")));
    const log = path.join(f.plan.logDir, "launchd.stderr.log");
    fs.writeFileSync(log, "existing log");
    assert.equal((await f.service.uninstall()).installed, false);
    assert.equal(fs.readFileSync(data, "utf8"), "existing database");
    assert.equal(fs.readFileSync(log, "utf8"), "existing log");
    assert.equal((await f.service.uninstall()).loaded, false);
  } finally { f.clean(); }
});

test("an occupied port or existing installation never overwrites configuration or kills a process", async () => {
  const f = fixture();
  try {
    f.occupy();
    await assert.rejects(f.service.install(f.plan), /port occupied/);
    assert.equal(fs.existsSync(f.service.file), false);
    assert.ok(!f.commands.some(c => ["bootout", "bootstrap"].includes(c[1]!)));
    fs.mkdirSync(path.dirname(f.service.file), { recursive: true });
    fs.writeFileSync(f.service.file, "existing config");
    await assert.rejects(f.service.install(f.plan), /already exists/);
    assert.equal(fs.readFileSync(f.service.file, "utf8"), "existing config");
  } finally { f.clean(); }
});

test("partial bootstrap failure removes only the new job and plist", async () => {
  const f = fixture();
  try {
    f.failBootstrap();
    await assert.rejects(f.service.install(f.plan), /Bootstrap failed/);
    assert.equal(fs.existsSync(f.service.file), false);
    assert.equal(f.service.status().loaded, false);
    assert.ok(f.commands.some(c => c[1] === "bootout"));
  } finally { f.clean(); }
});

test("management refuses mismatched labels and reports inspection errors", async () => {
  const f = fixture();
  try {
    await f.service.install(f.plan);
    f.config.Label = "another-service";
    await assert.rejects(f.service.uninstall(), /different service label/);
    assert.equal(fs.existsSync(f.service.file), true);
    f.config.Label = SERVICE_LABEL;
    f.failPrint();
    assert.throws(() => f.service.status(), /Operation not permitted/);
  } finally { f.clean(); }
});

test("failed rollback retains the plist so a partially loaded job remains manageable", async () => {
  const f = fixture();
  try {
    f.failBootstrap(); f.failBootout();
    await assert.rejects(f.service.install(f.plan), /retained .* for recovery/);
    assert.equal(fs.existsSync(f.service.file), true);
    assert.equal(f.service.status().loaded, true);
  } finally { f.clean(); }
});

test("listener preflight detects a real occupied port without terminating its owner", async () => {
  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  try {
    const address = listener.address() as net.AddressInfo;
    await assert.rejects(assertPortAvailable("127.0.0.1", address.port), /stop the existing server/);
    assert.equal(listener.listening, true);
  } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
});
