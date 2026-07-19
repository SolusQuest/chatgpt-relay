# Workflow: Issue placeholder → refined issue → implementation → PR

**References**:
- Relay API + usage patterns: [`agent-instructions.md`](../agent-instructions.md)

---

## What this workflow is

End-to-end flow for turning a rough / placeholder GitHub issue into a
production-quality PR, using the local relay as an independent reviewer /
brainstorming counterpart at two key decision points.

Deliberately slow — the goal is getting scope and coverage **right the first
time**, not shipping fast.

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
- User has authorized this workflow.
- **Pin the session at Phase 1 and reuse it across every relay call.**
  Continuity is the whole point: relay accumulates context across phases, so
  Phase 5's test brainstorm already knows what Phase 1 decided and what
  Phase 2 refined. Standard session-context assumptions apply — see
  SKILL.md.

---

## Phase 1 — Decision-point brainstorming (discussion mode)

Goal: figure out **all** the decisions that must be made explicit before the
issue can be called "refined". Use double-blind discussion mode to avoid
sycophancy.

**Round 0 & 1 — agent + relay in parallel** (recommended). Two hard barriers
guarantee independence, and within those barriers **run both concurrently** to
save the ~20–90s relay round-trip:

1. **Submit relay first (non-blocking)** with only the placeholder issue text
   (full, not summary) unless a remote issue/placeholder URL already exists. **No hint** of
   anything you (agent) already thought.
2. **After submit, immediately start agent's own thinking in scratchpad**:
   list the decision points you'd want resolved — scope boundaries, in/out,
   acceptance criteria, edge cases, dependencies, risks, naming, non-goals,
   migration/back-compat questions. **Persist to a visible draft** before
   polling relay back.
3. Poll relay for its independent list.

The barriers: (a) submit relay **before** writing any agent opinions; (b)
agent's list must be written down **before** reading relay's reply. Violate
either and it degrades to review mode.

Prompt skeleton:
```text
下面是一个 placeholder issue，我们想 refine 到可以直接实现。请独立列出你觉得
动手前必须明确的 decision points（scope 边界、AC、edge cases、依赖、风险、
naming、non-goals、migration 问题等），按类别分组，每点简述为什么重要。

--- issue ---
https://github.com/<org>/<repo>/issues/<n>

```

或者（无远端链接时）贴出 placeholder 全文：

```text
--- issue ---
<placeholder 全文>
```

**Round 2 — agent synthesizes**. Compare the two lists:
- Overlap: both raised → high confidence, keep
- Agent-only: judge — real gap in relay's view, or just style?
- Relay-only: judge — did agent miss it, or is it noise?
- Conflicts (same point, opposite view): mark for discussion round

**Round 3+ — discussion (only if significant diffs/conflicts)**. Send relay:
```text
我独立列出的 decision points 是 <A>；你列的是 <B>。请指出：
- 我遗漏的关键点
- 你没考虑到的约束
- 冲突点 <X> 的 rationale trade-off
```
Iterate. Hard cap: 3 rounds beyond Round 1.

**Termination**:
- Convergence: point sets overlap ~80%, remaining diffs stylistic → done
- Two consecutive rounds add no new arguments → done
- Substantive stalemate → **stop, present both views to user for tiebreak**
- Hard cap reached → same as stalemate

**Checkpoint before Phase 2**: if any point that emerged is genuinely a
**user decision** (product direction, scope tradeoff, "do we support X?"),
stop and ask user. Don't auto-resolve.

---

## Phase 2 — Refined issue draft (relay review loop)

Agent drafts a complete refined issue body incorporating the Phase 1
synthesis. Include:
- **Problem statement** (what and why)
- **Scope**: in / out / explicitly not-goals
- **Acceptance criteria** (concrete, testable)
- **Dependencies / risks**
- **Open questions** (if any left)

Send to relay for review (standard review mode). Prompt skeleton:
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

Present the refined issue draft to the user.

- **Approved** → `gh issue create` (or `gh issue edit <n>` if placeholder
  already exists on GitHub). Proceed to Phase 4.
- **Requests changes** → back to Phase 2 with user's feedback.
- **Aborted** → stop; still record the Phase 1 synthesis somewhere the user
  can find it.

---

## Phase 4 — Implementation

Standard agent implementation, driven by the issue's AC:
- Small, semantic commits
- Compile / typecheck / lint before each commit
- If during implementation you discover a decision point Phase 1 missed,
  **stop and go back to Phase 1 for that specific point** — do not silently
  guess

Push to a feature branch. Don't open a PR yet.

---

## Phase 5 — Test coverage brainstorming (discussion mode)

Same shape as Phase 1, but for test cases.

**Round 0 & 1 — agent + relay in parallel** (same shape as Phase 1):

1. **Submit relay first (non-blocking)** with the pushed code URL and a
   reference to the issue (which relay already reviewed in Phase 2 within
   this session). Prompt below.
2. **After submit, immediately** list test cases in scratchpad based on your
   reading of the code + issue AC: happy path, edge cases, boundaries,
   failure modes, concurrency / state if applicable. **Persist before
   polling relay back.**
3. Poll relay for its independent case list.

Relay prompt skeleton:

```text
Phase 4 的实现已经 push 到 <branch URL>。基于我们在这个会话里 refine 过的
issue AC，请独立列出你会覆盖的 test cases，每个 case 简述测什么、为什么重要。
按类别分组：happy / edge / boundary / failure / 其他。
```

**Round 2 / 3+ / termination**: same as Phase 1. Convergence here typically
means "both agree on the critical cases; residual diffs are 'nice to have'
vs 'not worth it'."

---

## Phase 6 — Write tests + open PR

Agent implements the test set from Phase 5 synthesis. Confirm:
- Tests fail against a naive / no-op implementation (or run TDD-style)
- Full test suite still passes
- Coverage of every AC bullet from the refined issue

Commit + push to the same feature branch. Open a **draft** PR:
```bash
gh pr create --draft --title "..." --body "..."
```

PR body: reference the issue, summarize what was implemented, and map each
AC bullet to the code / tests that satisfy it. (Relay already knows the
issue and the test strategy from earlier phases, so you don't need to
restate them for Phase 7.)

---

## Phase 7 — Relay reviews PR

Send the PR URL to relay (see agent-instructions.md § PR review). Do not
inline the diff. Prompt skeleton:
```text
请作为严格的代码 reviewer review 下面这个 PR，实现了我们之前 refine 过的
issue。优先列必须修改的问题；如果没有阻塞问题，请明确说可以合并，并列出
剩余的风险 / 后续任务。

PR: <url>
```

Iterate:
- Real issue → agent fixes → commit + push same branch → same URL for
  re-review
- Style / preference feedback in last round → note in handoff, don't
  necessarily change
- Convergence: relay explicitly says "no blocking issues" or "safe to
  request human review"

Do **not** merge or mark ready-for-review autonomously.

---

## Phase 8 — Hand off to user

Present to the user:
1. **PR link** (still draft)
2. **What was refined vs the placeholder** — one paragraph
3. **AC coverage** — checklist mapping each AC bullet → tests / code
4. **Decisions and disagreements** — where relay and agent initially
   disagreed (in Phase 1 or Phase 5), how it was resolved, and any
   remaining risks / open questions relay flagged
5. **Explicitly ask**: draft or ready-for-review? merge criteria?

User confirms → done. User promotes to ready-for-review or merges as they
see fit.

---

## Global rules

- **Never merge, mark ready-for-review, or close the issue autonomously.**
  Every phase either continues or hands to user.
- **Same session across all phases.** Non-negotiable — the workflow relies
  on relay's accumulating context.
- **If relay pauses / captcha at any phase**: stop, tell user, do not retry.
- **If the issue turns out to be trivial** (small bug fix, one-liner):
  abort and ask user if lightweight mode is preferred.
- **Discussion mode only at Phase 1 and Phase 5** (before an artifact
  exists, where independence matters). Phase 2 and Phase 7 are review mode
  because agent already produced the concrete artifact.
