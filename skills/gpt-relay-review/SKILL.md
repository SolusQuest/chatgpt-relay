---
name: gpt-relay-review
description: Use when the user wants ChatGPT (web app) to review, critique, provide a second opinion on, or engage in double-blind discussion about content via the local gpt-relay service at http://127.0.0.1:8765. Send GitHub PR/issue URLs when possible (the ChatGPT session already has connector access, including private repos), or send full text for standalone drafts (design docs, issue bodies, prompts, commit messages). Also supports discussion mode: both agent and relay produce independent analyses, then converge. Do not use for quick self-review, when no ChatGPT tab is available, when the user asked for a specific API-based model, or for content the user has not authorized to share with ChatGPT.
---

# gpt-relay-review

Send a piece of content to a user's live ChatGPT web session through the local
gpt-relay, then wait for the human-in-the-loop reply and return it. Zero API
cost -- uses the user's ChatGPT Plus subscription.

## When to use this skill

Trigger when **all** hold:
- The user explicitly asks for ChatGPT / GPT / "another model" to review, or
  the content warrants cross-model review (design docs, security-sensitive
  refactors, non-obvious PR reviews, issue body refinement, test coverage
  design, architecture choices).
- gpt-relay is running (verify with `health.mjs`) and at least one active
  ChatGPT tab exists (`sessions.mjs`).
- Content is text (Markdown / code / diffs) or a resolvable URL. Images and
  file attachments are not supported.

Do **not** trigger when:
- The user just wants quick internal self-review.
- No relay reachable or no active session -- surface the precondition, don't
  fall back silently.
- Content contains secrets the user hasn't authorized to share with ChatGPT.

## Session context assumptions (default: hold)

The ChatGPT session behind gpt-relay is the user's own logged-in session,
usually with pre-loaded conversation context. **Default assumptions**:

- The session **can access GitHub PR/issue URLs**, including the user's own
  private repos (ChatGPT connectors are authorized).
  → Prefer sending **URLs** over inlining diffs/issue bodies.
- The session **has necessary project / repo context** (architecture,
  terminology, current feature work).
  → Don't re-explain project background every prompt.
- The session is authenticated as the user.
  → OK to say "this is part of my X feature"; don't treat as cold Q&A.

**Downgrade only on explicit contradictory evidence**: relay says "I can't
see this URL" / "please paste the content", or the reply is clearly
off-topic. Then either (a) supply the missing context inline with a note, or
(b) stop and ask the user.

## Preconditions

Run these two checks first. If either fails, stop and tell the user how to
fix it -- do not attempt further calls.

```bash
node $SKILL_DIR/scripts/health.mjs
# ok (http://127.0.0.1:8765, sessions=N)         -> proceed
# relay not reachable at ...                     -> ask user to run `gpt-relay start`

node $SKILL_DIR/scripts/sessions.mjs
# [] or empty                                    -> ask user to open chatgpt.com
# [{...paused: true...}]                         -> ask user to solve captcha / limit
```

`$SKILL_DIR` is this skill's directory; on Codex it is available as the skill
source path. If not defined, resolve relative to this SKILL.md.

## Picking a session

`sessions.mjs` returns an array of sessions. Prefer, in order:
1. A session whose id matches a ChatGPT conversation the user just referenced
   (the id is the conversation UUID from `chatgpt.com/c/<uuid>`).
2. A session with `paused=false` and `pendingTasks=0` (idle, ready to work).
3. If multiple candidates remain, pick the one with the most recent
   `lastSeen`.

If no unpaused session exists, stop and report `pauseReason` to the user.

## Sending a review

```bash
# Preferred: read prompt from stdin so it never gets logged in shell history.
printf %s "$PROMPT" | node $SKILL_DIR/scripts/review.mjs \
    --session "$SESSION_ID" \
    --stdin \
    --timeout 600000
```

**Content shape**:
- **Have a GitHub PR/issue URL?** Send the URL, not the diff/body — see
  Session context assumptions above.
- **Have local uncommitted changes?** `git commit && git push` first, then
  send the PR URL. Never inline unpushed diffs; the reviewer's line
  references won't match anything the user can see.
- **Standalone text** (issue drafts, design docs, prompt drafts, commit
  message drafts): send the **full text**, numbered when multiple. Don't
  send summaries or "the important part".
- **Multiple drafts in one review**: format as `## Draft 1`, `## Draft 2`
  headings so relay can address them individually.

Behavior:
- On success, `review.mjs` prints the ChatGPT reply to stdout and exits 0.
- On task-level failure (paused mid-flight, expired, cancelled), exits 2 with
  a message on stderr.
- On overall timeout, exits 3 -- the task may still complete later; use
  `resume.mjs` to reclaim it.

Flags worth knowing:
- `--no-wait` fire-and-forget; prints `{"taskId":"…","status":"queued"}` and
  exits. Use when submitting several reviews in parallel to different
  sessions.
- `--cri <key>` supplies a client_request_id for idempotency. Reissuing the
  same key within the same session returns the original taskId instead of
  creating a duplicate. Recommended if the caller may retry.
- `--file <path>` read prompt from a file instead of stdin/argv.

## Discussion mode (double-blind, advanced)

For important decisions (issue scope refinement, test coverage design,
architecture / naming choices, etc.), one-shot review can be extended into
**discussion mode**: agent and relay produce independent analyses, then
merge. This reduces LLM sycophancy — whoever sees the other's answer first
tends to drift toward it.

**Core rule: two barriers guarantee independence — run in parallel within
them.** Agent reasoning is usually 5–30s while a relay round-trip is 20–90s;
serialising wastes the whole relay wait. As long as both barriers hold, agent
thinking and relay thinking should run **concurrently**.

Barriers (must both hold):
1. **Agent writes no opinion before submitting relay.** Build a facts-only
   prompt first (task description, issue placeholder, code, constraints);
   submit that; **only then** start agent's own reasoning.
2. **Agent's independent output must be persisted (scratchpad / draft file /
   message draft) before reading relay's reply.** No "I had that in my head".

```
Round 0 & 1 (parallel):
         - submit relay with a facts-only prompt (non-blocking → taskId)
         - immediately start agent reasoning in scratchpad → output A
           (persisted before polling relay back)
         - poll relay → output B
         (barriers: no agent opinion in submit; A written before reading B)
Round 2: agent compares A vs B — identify overlap, agent-only,
         relay-only, and conflicts
Round 3+ (optional): if diffs/conflicts are significant, send relay a
         discussion prompt like: "my view is <A>, yours is <B>. What am I
         missing? What are you not considering? For conflict <X>, what's
         the rationale trade-off?" → output C, iterate.
```

Parallel shape via the CLI (or API):
```bash
# 1) submit relay, non-blocking → prints JSON {"taskId":"..."}
TASK=$(gpt-relay review --session <id> --stdin --no-wait < facts.txt | jq -r .taskId)
# 2) do agent's own reasoning, persist to scratchpad-A.md
# 3) once A is written, fetch relay's reply
gpt-relay show "$TASK"        # snapshot; or GET /v1/tasks/:id?wait=60000
```
Or hit the API directly: `POST /v1/tasks` returns `{taskId,status}`
immediately; later `GET /v1/tasks/:id?wait=<ms>` long-polls until terminal.
See agent-instructions.md for the full API.

**When NOT to parallelise**: context still forming (align context serially
first, then diverge); or when the flow is intentionally sequential (agent
decides scope → relay reviews that scope — this is review, not discussion).

Reuse the **same session** across rounds (`--cri` optional; multi-turn
context is one of gpt-relay's advantages over stateless API calls).

**Termination**:
- Convergence: key points overlap ~80%, remaining diffs stylistic, or two
  consecutive rounds add no new arguments → stop and act on the synthesis
- Substantive stalemate: both sides have fully explained rationales but
  disagree on a decision point → stop, present both to the user
- Hard cap: 3 discussion rounds beyond Round 1
- External: session paused, degradation signal, user interrupt

**Anti-patterns**:
- Putting agent's opinion in the submit prompt → degrades to review mode
- Asking relay to grade agent's answer → same
- Blocking on relay before starting agent-side reasoning → wastes 20–90s
- Keeping agent's independent output "in head" until relay returns →
  cannot audit independence, invites post-hoc drift
- Discussing until "looks perfect" → overfit; discussion is for blind-spot
  detection, not polish
- Replacing user decisions with agent+relay consensus

## Handling long reviews

ChatGPT can take several minutes on large prompts. Defaults are:
- 默认客户端等待 600000 (10 min)；task 默认超时 1800000 (30 min)
- `--timeout` 同时用于 task timeout 与客户端 wait timeout（脚本默认将两者同步），单独上限均是
  3600000 (60 min)
- Long-poll chunks of 30s -- the script never busy-loops.

If the shell/agent is interrupted mid-wait, the taskId is preserved in
`~/.gpt-relay/pending/<taskId>.json`. Recover with:

```bash
node $SKILL_DIR/scripts/resume.mjs
```

This prints each pending task's current status and, for `done` tasks, the
full reply. Terminal tasks are auto-cleaned from the pending dir.

## Listing recent tasks

```bash
node $SKILL_DIR/scripts/list.mjs --last 10
node $SKILL_DIR/scripts/list.mjs --session <id> --last 5
```

Useful for debugging: shows submittedAt, status, elapsed time. To inspect
one task in full (prompt + reply), use the `gpt-relay show <taskId>` CLI if the
user has the gpt-relay binary installed.

## Failure modes and what to tell the user

| Symptom                                    | Root cause                             | User action                                    |
|--------------------------------------------|----------------------------------------|------------------------------------------------|
| `relay not reachable`                      | server not running                     | run `gpt-relay start` or `node server/index.ts`    |
| `sessions.mjs` returns `[]`                | no chatgpt.com tab active              | open chatgpt.com and confirm green banner      |
| session `paused: true, pauseReason: ...`   | captcha / rate limit / unusual activity | solve in browser; extension will auto-resume  |
| `review.mjs` exits 2, error mentions "文本注入失败" | ChatGPT frontend changed selectors     | update extension selectors                     |
| `review.mjs` exits 3 (timeout)             | reply took longer than timeout         | run `resume.mjs` later to reclaim              |
| HTTP 429 queue_full                        | too many pending tasks in this session | wait or cancel with `gpt-relay cancel <taskId>`    |
| HTTP 413 task_too_large                    | prompt bigger than server limit        | split the prompt                               |

## Environment variables

- `GPT_RELAY_URL` - override relay URL (default `http://127.0.0.1:8765`).
- `GPT_RELAY_PORT` - alternative to GPT_RELAY_URL, sets port on localhost.
- `GPT_RELAY_PENDING_DIR` - alt location for pending files (default
  `~/.gpt-relay/pending`).

## Multi-session parallel review

The relay allows one in-flight task per session but many sessions
concurrently. To run several reviews in parallel, pick multiple sessions,
submit with `--no-wait`, then follow up with `resume.mjs` when convenient.

```bash
for s in $(node scripts/sessions.mjs | jq -r '.[] | select(.paused==false) | .session'); do
  echo "$PROMPT" | node scripts/review.mjs --session "$s" --stdin --no-wait
done
# ... do other work ...
node scripts/resume.mjs
```

## Data & privacy

All prompts and replies are stored **locally** in the relay's SQLite
database (`~/.gpt-relay/gpt-relay.db`) so tasks survive process restarts and
allow post-hoc review. Nothing leaves the user's machine except the request
to their own ChatGPT tab. If the user asks to purge history:

```bash
gpt-relay tasks --last 100    # to see what is there
rm ~/.gpt-relay/gpt-relay.db*  # or, non-destructive: `gpt-relay prune` (planned)
```
