import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";

export const SERVICE_LABEL = "io.github.solusquest.gpt-relay";
export interface ServicePlan {
  node: string;
  loader: string;
  root: string;
  environment: Record<string, string>;
  logDir: string;
}
interface CommandResult { status: number | null; stdout: string; stderr: string }
type Runner = (command: string, args: string[]) => CommandResult;
const run: Runner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
};
const xml = (text: string) => text.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

export function renderPlist(plan: ServicePlan): string {
  const args = [plan.node, "--import", plan.loader, path.join(plan.root, "server", "index.ts")];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(plan.root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(plan.environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(path.join(plan.logDir, "launchd.stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(plan.logDir, "launchd.stderr.log"))}</string>
</dict></plist>
`;
}

// Reserve and immediately release the exact listener before installation/start.
// This prevents taking over a foreground server or installing a restart loop.
export async function assertPortAvailable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", error => reject(new Error(`cannot listen on ${host}:${port}; stop the existing server or check the address (${(error as NodeJS.ErrnoException).code})`, { cause: error })));
    server.listen({ host, port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
  });
}

export class MacOSService {
  readonly file: string;
  readonly domain: string;
  readonly target: string;
  constructor(home: string, uid: number, private runner: Runner = run,
    private portAvailable = assertPortAvailable) {
    this.file = path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    this.domain = `gui/${uid}`;
    this.target = `${this.domain}/${SERVICE_LABEL}`;
  }
  private command(command: string, args: string[]): string {
    const result = this.runner(command, args);
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr.trim() || result.stdout.trim() || result.status}`);
    return result.stdout;
  }
  private loaded(): string | null {
    const result = this.runner("/bin/launchctl", ["print", this.target]);
    if (result.status === 0) return result.stdout;
    if (/Could not find (?:specified )?service/i.test(result.stderr)) return null;
    throw new Error(`cannot inspect login service: ${result.stderr.trim() || result.stdout.trim() || result.status}`);
  }
  private configuration(): { EnvironmentVariables: Record<string, string>; StandardOutPath: string; StandardErrorPath: string } {
    if (!fs.existsSync(this.file)) throw new Error("login service is not installed; run gpt-relay service install");
    const config = JSON.parse(this.command("/usr/bin/plutil", ["-convert", "json", "-o", "-", this.file]));
    if (config.Label !== SERVICE_LABEL) throw new Error("refusing to manage a plist with a different service label");
    return config;
  }
  private async unload() {
    this.command("/bin/launchctl", ["bootout", this.target]);
    const deadline = Date.now() + 30_000;
    while (this.loaded() !== null) {
      if (Date.now() >= deadline) throw new Error("login service did not finish unloading within 30 seconds");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  status() {
    const installed = fs.existsSync(this.file);
    const config = installed ? this.configuration() : null;
    const detail = this.loaded();
    const pid = detail?.match(/^\s*pid = (\d+)\s*$/m)?.[1];
    return { platform: "darwin", label: SERVICE_LABEL, plist: this.file, installed,
      loaded: detail !== null, running: pid !== undefined, pid: pid ? Number(pid) : null,
      listener: config ? { host: config.EnvironmentVariables.GPT_RELAY_HOST, port: Number(config.EnvironmentVariables.GPT_RELAY_PORT) } : null,
      logs: config ? { stdout: config.StandardOutPath, stderr: config.StandardErrorPath } : null };
  }
  async install(plan: ServicePlan, dryRun = false) {
    const plist = renderPlist(plan);
    if (dryRun) return { plist: this.file, content: plist };
    if (fs.existsSync(this.file) || this.loaded() !== null) throw new Error("login service already exists; uninstall it before installing new settings (database and logs are retained)");
    await this.portAvailable(plan.environment.GPT_RELAY_HOST!, Number(plan.environment.GPT_RELAY_PORT));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.mkdirSync(plan.logDir, { recursive: true });
    fs.writeFileSync(this.file, plist, { flag: "wx", mode: 0o600 });
    try {
      this.command("/usr/bin/plutil", ["-lint", this.file]);
      // Explicitly enable our own label, in case an earlier login item disabled it.
      this.command("/bin/launchctl", ["enable", this.target]);
      this.command("/bin/launchctl", ["bootstrap", this.domain, this.file]);
    } catch (error) {
      // Bootstrap may have partially succeeded; remove only this new job.
      try {
        if (this.loaded() !== null) await this.unload();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `installation failed and rollback could not unload the job; retained ${this.file} for recovery`);
      }
      fs.unlinkSync(this.file);
      throw error;
    }
    return this.status();
  }
  async start() {
    const config = this.configuration();
    const detail = this.loaded();
    if (detail === null) {
      await this.portAvailable(config.EnvironmentVariables.GPT_RELAY_HOST!, Number(config.EnvironmentVariables.GPT_RELAY_PORT));
      this.command("/bin/launchctl", ["enable", this.target]);
      this.command("/bin/launchctl", ["bootstrap", this.domain, this.file]);
    }
    return this.status();
  }
  async stop() {
    this.configuration();
    if (this.loaded() !== null) await this.unload();
    return this.status();
  }
  async restart() {
    const config = this.configuration();
    await this.stop(); // bootout allows the server's SIGTERM cleanup; kickstart -k does not.
    // bootout can return before the old process releases its listening socket.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await this.portAvailable(config.EnvironmentVariables.GPT_RELAY_HOST!, Number(config.EnvironmentVariables.GPT_RELAY_PORT));
        break;
      } catch (error) {
        if ((error as Error).cause && ((error as Error).cause as NodeJS.ErrnoException).code === "EADDRINUSE" && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 250));
        } else throw error;
      }
    }
    return this.start();
  }
  async uninstall() {
    if (fs.existsSync(this.file)) {
      await this.stop();
      fs.unlinkSync(this.file);
    } else if (this.loaded() !== null) {
      throw new Error("loaded job has no managed plist; inspect it with launchctl before removing it");
    }
    return this.status();
  }
}
