// test/encoding-fix.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tryFixEncoding, decodeSmart } from "../server/encoding-fix.js";

test("passes through plain ASCII unchanged", () => {
  const r = tryFixEncoding("hello world");
  assert.equal(r.fixed, false);
  assert.equal(r.text, "hello world");
});

test("passes through valid UTF-8 CJK unchanged", () => {
  const input = "帮我 review 一下这段代码";
  const r = tryFixEncoding(input);
  assert.equal(r.fixed, false);
  assert.equal(r.text, input);
  assert.equal(r.method, "none");
});

test("recovers latin-1 mojibake back to CJK", () => {
  // 模拟：UTF-8 字节 "帮我" 被当 Latin-1 读，然后再 UTF-8 编码
  const original = "帮我 review";
  const utf8Bytes = Buffer.from(original, "utf8"); // e5 b8 ae e6 88 91
  const mojibake = utf8Bytes.toString("latin1");    // "å¸®æˆ‘ review" 形态
  const r = tryFixEncoding(mojibake);
  assert.equal(r.fixed, true, `note: ${r.note}`);
  assert.equal(r.method, "latin1-remap");
  assert.equal(r.text, original);
});

test("warns on all-? input (ASCII-lossy from client)", () => {
  const r = tryFixEncoding("?? review ??????");
  assert.equal(r.fixed, false);
  assert.equal(r.method, "ascii-lossy-warn");
  assert.match(r.note ?? "", /ASCII|encoded/);
});

test("warns on U+FFFD replacement chars", () => {
  const r = tryFixEncoding("\ufffd\ufffd review \ufffd\ufffd");
  assert.equal(r.fixed, false);
  assert.equal(r.method, "ascii-lossy-warn");
});

test("passes through mixed English with occasional ?", () => {
  // 英文正常出现的问号不应触发警告
  const r = tryFixEncoding("Should we merge this? Or wait?");
  assert.equal(r.fixed, false);
  assert.equal(r.method, "none");
});

test("decodeSmart identifies valid UTF-8", () => {
  const buf = Buffer.from("你好 world", "utf8");
  const r = decodeSmart(buf);
  assert.equal(r.text, "你好 world");
  assert.equal(r.fixed, false);
});

test("decodeSmart recovers GBK bytes", () => {
  // "帮我" 在 GBK 里是 b0 ef ce d2
  const buf = Buffer.from([0xb0, 0xef, 0xce, 0xd2, 0x20, 0x72, 0x65, 0x76, 0x69, 0x65, 0x77]);
  const r = decodeSmart(buf);
  assert.equal(r.fixed, true);
  assert.equal(r.method, "gbk-remap");
  assert.equal(r.text, "帮我 review");
});

test("decodeSmart falls back to lossy UTF-8 for garbage", () => {
  const buf = Buffer.from([0xff, 0xfe, 0xfd]);
  const r = decodeSmart(buf);
  assert.equal(r.method, "ascii-lossy-warn");
});