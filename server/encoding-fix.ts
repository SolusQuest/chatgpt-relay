// server/encoding-fix.ts
// 尝试识别并修正客户端传来的可能被错误编码的文本。
//
// 三种常见破坏方式：
//   A. GBK 原始字节被当 UTF-8 解码（浏览器/终端在 Windows-936 环境常见）
//      → 得到大量 U+FFFD (replacement) 混杂
//   B. UTF-8 字节被当 Latin-1 解码后再编码 UTF-8（"mojibake"，双重解码）
//      → 得到形如 "帮æˆ‘" 的西欧扩展字符序列
//   C. 客户端在编码前就用 ASCII 破坏（? 替换）
//      → 无法恢复，标记为 lossy
//
// 我们不修改"看起来正常"的输入。仅当能明确改善时才转换，且总是尝试
// 保留原文（转换后可 round-trip 回原字节）。

export interface DecodeResult {
  text: string;
  fixed: boolean;
  method: "none" | "gbk-remap" | "latin1-remap" | "ascii-lossy-warn";
  note?: string;
}

// 判定字符串"含中日韩字符的可能性"
function cjkChars(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    // CJK Unified Ideographs (basic) + Extension A + 中文标点
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)
        || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) {
      n++;
    }
  }
  return n;
}
function replacementChars(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === "\ufffd") n++;
  return n;
}
function asciiQuestionRuns(s: string): number {
  // 连续 3 个以上的 "?" 且前后不是英文（启发式：作为句子中间的"？"占位）
  let max = 0, cur = 0;
  for (const ch of s) {
    if (ch === "?") { cur++; if (cur > max) max = cur; }
    else cur = 0;
  }
  return max;
}
function latin1Mojibake(s: string): number {
  // 典型 mojibake 特征字符：Ã ¤ ¥ Â å  æ ç etc.
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x80 && c <= 0xff && c !== 0xa0) n++;
  }
  return n;
}

/**
 * 尝试从"客户端说是 UTF-8 但可能不是"的字符串里恢复本意。
 * 输入是 Express 已经用 UTF-8 decode 好的 string；我们把它反编码回字节
 * 再尝试不同解码。
 */
export function tryFixEncoding(input: string): DecodeResult {
  if (!input) return { text: input, fixed: false, method: "none" };

  // ── Case A: 输入含 U+FFFD → 原始字节大概率是 GBK 被当 UTF-8 ──
  const fffd = replacementChars(input);
  if (fffd > 0) {
    // 我们没法从已经出现 U+FFFD 的 string 恢复原字节（Express/Node 的 UTF-8
    // decoder 已经用 fatal:false 替换掉了）。但如果整段里 fffd 占比 >20%
    // 说明客户端本来就是错的，直接提示上层调用者。
    return {
      text: input,
      fixed: false,
      method: "ascii-lossy-warn",
      note: `input contains ${fffd} replacement chars; client likely sent non-UTF-8 bytes`,
    };
  }

  // ── Case C: 含大量 "?" 无法恢复 ──
  // 只在整段没有 CJK、但含大段 ??? 时警告（英文里也可能自然出现）
  const cjk = cjkChars(input);
  const qs = asciiQuestionRuns(input);
  if (cjk === 0 && qs >= 3) {
    return {
      text: input,
      fixed: false,
      method: "ascii-lossy-warn",
      note: `input has run of ${qs} '?' with no CJK; client likely encoded to ASCII`,
    };
  }

  // ── Case B: mojibake (UTF-8 bytes read as Latin-1 then re-encoded) ──
  // 检测启发式：含 latin-1 扩展区字符 且 不含真实 CJK。
  const l1 = latin1Mojibake(input);
  if (l1 >= 3 && cjk === 0) {
    try {
      // 反过来编码：把当前字符串当作 latin-1 编码到字节，再当 UTF-8 解码
      const bytes = Buffer.from(input, "latin1");
      const recovered = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (cjkChars(recovered) > 0) {
        return {
          text: recovered,
          fixed: true,
          method: "latin1-remap",
          note: `recovered ${cjkChars(recovered)} CJK chars from latin-1 mojibake`,
        };
      }
    } catch {
      // 不是有效 UTF-8，放弃
    }
  }

  // ── 输入看起来正常 ──
  return { text: input, fixed: false, method: "none" };
}

/**
 * 处理 raw buffer 的版本：用于我们能直接拿到原始请求字节的场景（例如
 * Express 的 raw body）。可以尝试多个编码找出最合理的。
 */
export function decodeSmart(buf: Buffer): DecodeResult {
  // 优先 UTF-8 (fatal)
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { text: utf8, fixed: false, method: "none" };
  } catch { /* 不是有效 UTF-8 */ }

  // 尝试 GBK（Windows 中文常见）
  try {
    const gbk = new TextDecoder("gbk", { fatal: false }).decode(buf);
    if (cjkChars(gbk) > 0 && replacementChars(gbk) === 0) {
      return { text: gbk, fixed: true, method: "gbk-remap",
        note: `decoded ${buf.length} bytes as GBK` };
    }
  } catch { /* ignore */ }

  // 退回 utf-8 with replacement chars
  const lossy = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  return {
    text: lossy,
    fixed: false,
    method: "ascii-lossy-warn",
    note: "buffer is not valid UTF-8 or GBK",
  };
}