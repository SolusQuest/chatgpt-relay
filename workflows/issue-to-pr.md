# Workflow: Issue placeholder → refined issue → implementation → PR

**References**:
- Relay API + usage patterns: [`agent-instructions.md`](../agent-instructions.md)
- Skill (if invoked as a Codex/Claude skill): [`skills/gpt-relay-review/SKILL.md`](../skills/gpt-relay-review/SKILL.md)
- Discussion mode mechanics: see the "讨论 / 独立思考 + 综合" section in
  agent-instructions.md, or the "Discussion mode" section in SKILL.md

---

## What this workflow is

End-to-end flow for turning a rough / placeholder GitHub issue into a
production-quality PR, using the local relay as an independent reviewer /
brainstorming counterpart at two key decision points.

Deliberately slow — 6–8 relay round-trips totalling several minutes of wall
time — because the goal is getting scope and coverage **right the first time**,
not shipping fast.

## When to use / not to use

**Use** when:
- There's a placeholder issue, rough draft, or "here's a problem I noticed"
  note that isn't yet ready to implement.
- The problem is non-trivial: real scope questions, non-obvious edge cases,
  or design choices that would be expensive to redo.
- User has authorized both agent and relay to work on the codebase / issue.

**Do not use** for:
- Bug hotfixes with obvious scope and fix.
- Small, urgent changes the user wants done immediately.
- Anything the user explicitly asked to do quickly / without ceremony.

If mid-workflow you realize the issue is actually small, **stop and ask the
user** whether to switch to lightweight mode.

## Preconditions

- gpt-relay reachable and at least one non-paused ChatGPT session available
  (see agent-instructions.md § "使用前 sanity check").
- User has authorized this workflow, or invoked a skill / slash command that
  triggers it.
- The relay session either already has repo/project context loaded, or you're
  prepared to supply it inline when relay signals "no context" (see
  Session context assumptions in SKILL.md).
- **Pin the session**: note the chosen session id at Phase 1 and reuse it
  across every relay call in the workflow. Continuity gives discussion mode
  and later review consistency; ChatGPT's multi-turn conversation memory is
  one of relay's key advantages over stateless API calls.

---

## Phase 1 — Decision-point brainstorming (discussion mode)

Goal: figure out **all** the decisions that must be made explicit before the
issue can be called "refined". Use double-blind discussion mode to avoid
sycophancy.

**Round 0 — agent, independently**. In scratchpad only, list the decision
points you'd want resolved: scope boundaries, in/out, acceptance criteria,
edge cases, dependencies, risks, naming, non-goals, migration/back-compat
questions. Do **not** send this list to relay yet.

**Round 1 — relay, independently**. Send relay a prompt containing:
- The placeholder issue text (full, not summary)
- Objective context (e.g. link to related code, existing constraint docs)
- **No** hint of what you (agent) already thought

Prompt skeleton:
```text
下面是一个 placeholder issue，我们想把它 refine 到可以直接实现。请列出你觉得
在动手前必须明确的 decision points（scope 边界、AC、edge cases、依赖、风险、
naming、non-goals、migration 问题等）。请按类别分组列出，每个点简述为什么它
重要。

--- issue ---
<placeholder 全文>
```

**Round 2 — agent synthesizes**. Compare the two lists:
- Overlap: both raised → high confidence, keep
- Agent-only: judge — real gap in relay's view, or just style?
- Relay-only: judge — did agent miss it, or is it noise?
- Conflicts (same point, opposite view): mark for discussion round

**Round 3+ — discussion (only if significant diffs/conflicts)**. Send relay
(same session):
```text
我独立列出的 decision points 是 <A>；你列的是 <B>。请指出：
- 我遗漏的关键点（如果有）
- 你没考虑到的约束
- 对冲突点 <X> 的 rationale trade-off
```
Iterate. Hard cap: 3 rounds beyond Round 1.

**Termination**:
- Convergence: point sets overlap ~80%, remaining diffs stylistic → done
- Two consecutive rounds add no new arguments → done
- Substantive stalemate → **stop, present both views to user for tiebreak**
- Hard cap reached → same as stalemate

**Checkpoint before Phase 2**:
- If any point that emerged is genuinely a **user decision** (product
  direction, scope tradeoff, "do we support X?"), stop and ask user before
  drafting the refined issue. Don't auto-resolve.
- If everything is engineering-technical and convergence is clean, proceed.

---

## Phase 2 — Refined issue draft (relay review loop)

Agent drafts a complete refined issue body incorporating the Phase 1
synthesis. Include:
- **Problem statement** (what and why)
- **Scope**: in / out / explicitly not-goals
- **Design overview** (rough approach)
- **Acceptance criteria** (concrete, testable)
- **Dependencies / risks**
- **Open questions** (if any left)

Send to relay for review (this is now standard review mode, not discussion —
see SKILL.md § Sending a review). Prompt skeleton:
```text
请作为严格的 PM/工程 reviewer 审查下面的 refined issue body。重点检查：
scope 是否清楚、AC 是否可执行、依赖 / 风险是否遗漏、是否有含糊措辞。
按严重程度列问题；没有阻塞问题就明确说可以推进。

---
<refined issue 全文>
```

Iterate until relay reports "no blocking issues" (read the reply
semantically, don't keyword-match). Style-preference feedback in the last
round is fine to ignore.

## Phase 3 — User checkpoint before implementation

Present the refined issue draft to the user. **Do not skip this**.

User either:
- **Approves** → `gh issue create` (or `gh issue edit <n>` if placeholder
  already exists on GitHub). Proceed to Phase 4.
- **Requests changes** → back to Phase 2 with user's feedback.
- **Aborts** → stop; the value from Phase 1 synthesis is still worth
  recording somewhere the user can find it.

Implementation without a user-signed issue is high risk — a wrong scope
decision downstream wastes hours.

---

## Phase 4 — Implementation

Standard agent implementation, driven by the issue's AC:
- Small, semantic commits
- Compile / typecheck / lint before each commit
- If during implementation you discover a decision point Phase 1 missed,
  **stop and go back to Phase 1 for that specific point** — do not silently
  guess

Push to a feature branch. Do not open a PR yet if you plan to run Phase 5
before writing tests (tests should be part of the initial PR).

---

## Phase 5 — Test coverage brainstorming (discussion mode)

Same shape as Phase 1, but for test cases. Goal: don't ship with obvious
blind spots.

**Round 0 — agent, independently**. In scratchpad, list test cases based on
your reading of the code + issue AC. Cover: happy path, edge cases,
boundaries (numeric, empty, malformed), failure modes, concurrency / state
if applicable.

**Round 1 — relay, independently**. Send:
- Code under test (as GitHub URLs if pushed, else inline)
- Issue AC
- **No** hint of what you already listed

Prompt skeleton:
```text
下面是待测的代码和它对应的 AC。请列出你会覆盖的 test cases，每个 case 简述
测什么以及为什么重要。按类别分组：happy path / edge / boundary / failure /
其他。

--- 代码 ---
<file content 或 URL>

--- AC ---
<AC 列表>
```

**Round 2 / 3+** — same merge / diff / discuss as Phase 1.

**Termination**: same as Phase 1. Convergence typically here means
"both agree on the critical cases; the residual diffs are 'nice to have'
vs 'not worth it'."

---

## Phase 6 — Write tests + open PR

Agent implements the test set from Phase 5 synthesis. Confirm:
- Tests fail against a naive / no-op implementation (or run TDD-style)
- Full test suite still passes
- Coverage of every AC bullet from the refined issue

Commit + push to the same feature branch. Open a PR (draft is default):
```bash
gh pr create --draft --title "..." --body "..."
```

PR body should reference the issue and briefly summarize what was implemented.

---

## Phase 7 — Relay reviews PR

Send the **PR URL** to relay (see agent-instructions.md § PR review). Do
not inline the diff. Prompt skeleton:
```text
请作为严格的代码 reviewer review 下面这个 PR。优先列必须修改的问题；
如果没有阻塞问题，请明确说可以合并，并列出剩余的风险 / 后续任务。

PR: <url>
```

Iterate:
- Real issue → agent fixes → commit + push same branch → same URL for
  re-review (ChatGPT will re-fetch the updated PR)
- Style / preference feedback in last round → note in handoff, don't
  necessarily change
- Convergence: relay explicitly says "no blocking issues" or "safe to
  request human review"

**Do not** merge or mark ready-for-review autonomously.

---

## Phase 8 — Hand off to user

Present to the user:
1. **PR link** (still draft)
2. **What was refined vs the placeholder** — one paragraph
3. **Coverage of AC** — checklist showing each AC bullet → which test(s)
   / code path
4. **Remaining risks / open questions** relay flagged that were not
   auto-resolved
5. **Decisions made** where relay and agent initially disagreed, and how
   they were resolved
6. **Explicitly ask**: draft or ready-for-review? merge criteria?

User confirms → done. User promotes to ready-for-review or merges as
they see fit.

---

## Global rules

- **Never merge, mark ready-for-review, or close the issue autonomously.**
  Every phase either continues or hands to user.
- **Same session across all phases** of a single issue-to-PR run.
- **If relay pauses / captcha at any phase**: stop, tell user, do not retry.
- **If relay repeatedly signals no context** (see downgrade signals in
  SKILL.md): don't push through with guesses. Either supply the missing
  context inline (with a note), or ask user to pull the right conversation
  to the foreground.
- **If the issue turns out to be trivial** (small bug fix, one-liner):
  abort the workflow and ask user if lightweight mode is preferred.
- **Discussion mode is not required in every phase**: Phase 2 (issue review)
  and Phase 7 (PR review) are review mode (one voice: relay), because agent
  already made the concrete artifact. Phase 1 and Phase 5 use discussion
  mode because independence matters *before* an artifact exists.

## Time / effort

Approximate wall clock:
- Phase 1: 3–5 minutes (2 relay round-trips + potential discussion)
- Phase 2: 2–5 minutes per review iteration (usually 1–2 iterations)
- Phase 3: 1–5 minutes user review
- Phase 4: minutes to hours depending on implementation
- Phase 5: 3–5 minutes
- Phase 6: minutes to hours
- Phase 7: 2–5 minutes per iteration
- Phase 8: 1–5 minutes user handoff

Full workflow: usually 20–60 minutes of orchestration overhead beyond
raw implementation. Skip only when scope is trivial.
