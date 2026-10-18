import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliOutput, OutputWriteError } from "../client/cli-output.js";
import { parseGlobalOptions } from "../client/cli-options.js";

test("output flags do not consume literal input or backend options", () => {
  const result = parseGlobalOptions(["review", "--session", "s", "--text", "--output", "--server", "host:8765", "--output", "result.json"]);
  assert.deepEqual(result.args, ["review", "--session", "s", "--text", "--output"]);
  assert.deepEqual(result.options, { server: "host:8765" });
  assert.equal(result.output, "result.json");
});

test("write and rename failures leave the previous complete file and remove temporary files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-output-failure-"));
  try {
    const target = path.join(dir, "result.json");
    const previous = '{"previous":true}\n';
    fs.writeFileSync(target, previous);
    for (const method of ["writeFileSync", "renameSync"] as const) {
      const output = new CliOutput();
      output.prepare(target);
      const mocked = t.mock.method(fs, method, () => { throw new Error("simulated disk failure"); });
      try {
        assert.throws(() => method === "writeFileSync" ? output.write('{"partial":') : output.commit(),
          (err: unknown) => err instanceof OutputWriteError && err.code === "output_write_failed" && err.message.includes(target));
      } finally { mocked.mock.restore(); output.abort(); }
      assert.equal(fs.readFileSync(target, "utf8"), previous);
      assert.deepEqual(fs.readdirSync(dir), ["result.json"]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
