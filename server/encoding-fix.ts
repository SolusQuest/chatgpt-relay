// server/encoding-fix.ts
// Detect and repair text that may have been incorrectly encoded by a client.
//
// Three common corruption modes:
//   A. Raw GBK bytes decoded as UTF-8, common in Windows-936 environments.
//      This produces many U+FFFD replacement characters.
//   B. UTF-8 bytes decoded as Latin-1 and encoded as UTF-8 again (mojibake).
//      This produces sequences of Western European extended characters.
//   C. A client replaces characters with "?" during ASCII conversion.
//      This cannot be recovered and is marked as lossy.
//
// Leave normal-looking input unchanged. Convert only when it clearly improves
// the text and preserve round-trip fidelity whenever possible.

export interface DecodeResult {
  text: string;
  fixed: boolean;
  method: "none" | "gbk-remap" | "latin1-remap" | "ascii-lossy-warn";
  note?: string;
}

// Heuristic for text that probably contains CJK characters.
function cjkChars(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    // Basic CJK Unified Ideographs, Extension A, and CJK punctuation.
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
  // Three or more consecutive "?" characters suggest lossy substitution.
  let max = 0, cur = 0;
  for (const ch of s) {
    if (ch === "?") { cur++; if (cur > max) max = cur; }
    else cur = 0;
  }
  return max;
}
function latin1Mojibake(s: string): number {
  // Characters commonly found in mojibake, such as Ã, ¤, ¥, Â, å, æ, and ç.
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x80 && c <= 0xff && c !== 0xa0) n++;
  }
  return n;
}

/**
 * Attempt to recover a string that the client labeled as UTF-8.
 * Express has already decoded the input, so reconstruct candidate bytes and
 * try alternative decoding paths.
 */
export function tryFixEncoding(input: string): DecodeResult {
  if (!input) return { text: input, fixed: false, method: "none" };

  // Case A: U+FFFD suggests that non-UTF-8 source bytes were decoded as UTF-8.
  const fffd = replacementChars(input);
  if (fffd > 0) {
    // Original bytes cannot be recovered after a non-fatal UTF-8 decoder has
    // replaced them. A high replacement ratio still lets us warn the caller.
    return {
      text: input,
      fixed: false,
      method: "ascii-lossy-warn",
      note: `input contains ${fffd} replacement chars; client likely sent non-UTF-8 bytes`,
    };
  }

  // Case C: repeated "?" characters are lossy and cannot be recovered.
  // Warn only when the text has no CJK but contains a suspicious run.
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
  // Heuristic: Latin-1 extended characters are present but real CJK is absent.
  const l1 = latin1Mojibake(input);
  if (l1 >= 3 && cjk === 0) {
    try {
      // Re-encode as Latin-1 bytes, then decode those bytes as UTF-8.
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
      // The reconstructed bytes are not valid UTF-8.
    }
  }

  // The input looks normal.
  return { text: input, fixed: false, method: "none" };
}

/**
 * Raw-buffer variant for callers that have the original request bytes.
 * Try multiple decoders and choose the most plausible result.
 */
export function decodeSmart(buf: Buffer): DecodeResult {
  // Prefer strict UTF-8.
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { text: utf8, fixed: false, method: "none" };
  } catch { /* Not valid UTF-8. */ }

  // Try GBK, which is common in Chinese Windows environments.
  try {
    const gbk = new TextDecoder("gbk", { fatal: false }).decode(buf);
    if (cjkChars(gbk) > 0 && replacementChars(gbk) === 0) {
      return { text: gbk, fixed: true, method: "gbk-remap",
        note: `decoded ${buf.length} bytes as GBK` };
    }
  } catch { /* ignore */ }

  // Fall back to UTF-8 with replacement characters.
  const lossy = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  return {
    text: lossy,
    fixed: false,
    method: "ascii-lossy-warn",
    note: "buffer is not valid UTF-8 or GBK",
  };
}
