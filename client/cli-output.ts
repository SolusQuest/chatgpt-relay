import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { format } from "node:util";

export class OutputWriteError extends Error {
  readonly code = "output_write_failed";
  constructor(target: string, cause: unknown) {
    super(`cannot save output to ${target}: ${(cause as Error).message}. The command may already have run; inspect the existing task/operation before retrying.`, { cause });
  }
}

/** Tee stdout to a private sibling file; publish only a complete command result. */
export class CliOutput {
  private target?: string;
  private temporary?: string;
  private fd?: number;
  private resultWritten = false;

  prepare(target: string): void {
    this.target = path.resolve(target);
    this.temporary = path.join(path.dirname(this.target), `.gpt-relay-output-${randomUUID()}.tmp`);
    try {
      if (fs.existsSync(this.target) && fs.statSync(this.target).isDirectory()) {
        throw new Error("output path is a directory");
      }
      this.fd = fs.openSync(this.temporary, "wx", 0o600);
    } catch (cause) { throw new OutputWriteError(this.target, cause); }
  }

  log(...args: unknown[]): void {
    this.write(format(...args) + "\n");
  }

  write(text: string): void {
    this.resultWritten = true;
    if (this.fd !== undefined) {
      try { fs.writeFileSync(this.fd, text, "utf8"); }
      catch (cause) { throw new OutputWriteError(this.target!, cause); }
    }
    process.stdout.write(text);
  }

  commit(exitCode = 0): void {
    if (this.fd === undefined) return;
    if (exitCode !== 0 && !this.resultWritten) {
      this.abort();
      return;
    }
    try {
      fs.closeSync(this.fd);
      this.fd = undefined;
      fs.renameSync(this.temporary!, this.target!);
      this.temporary = undefined;
    } catch (cause) { throw new OutputWriteError(this.target!, cause); }
  }

  abort(): void {
    if (this.fd !== undefined) {
      try { fs.closeSync(this.fd); } catch { /* Preserve the original error. */ }
      this.fd = undefined;
    }
    if (this.temporary) {
      try { fs.unlinkSync(this.temporary); } catch { /* Best effort cleanup. */ }
      this.temporary = undefined;
    }
  }
}
