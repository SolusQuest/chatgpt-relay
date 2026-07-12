---
name: cgcon-review
description: Use when the user wants ChatGPT (web app) to review, critique, or provide a second opinion on content via the local cgcon relay running at http://127.0.0.1:8766. Ideal for design docs, PR diffs, ambiguous refactors, architecture choices, prompt drafts, or any high-stakes decision where the user already has an authenticated ChatGPT tab open. Do not use for quick self-review, when no ChatGPT tab is available, or when the user asked for a specific API-based model.
---

# cgcon-review

Send a piece of content to a user's live ChatGPT web session through the local
cgcon relay, then wait for the human-in-the-loop reply and return it. Zero API
cost -- uses the user's ChatGPT Plus subscription.

## When to use this skill

Trigger when **all** of these hold:
- The user explicitly asks for ChatGPT / GPT / "another model" to review or
  second-opinion a piece of content, **or** the content is important enough
  that cross-model review is clearly valuable (long design docs, security
  reviews, non-obvious refactor plans, big PR descriptions).
- The user already has cgcon running (check with `health.mjs`) and at least
  one active ChatGPT tab (check with `sessions.mjs`).
- The content is text (Markdown / code / diffs). Images and file attachments
  are not supported.

Do **not** trigger when:
- The user just wants a quick internal self-check.
- No relay is reachable or no session is active -- surface the missing
  precondition instead of falling back silently.
- The content contains secrets the user has not explicitly authorized to
  share with ChatGPT.

## Preconditions

Run these two checks first. If either fails, stop and tell the user how to
fix it -- do not attempt further calls.

```bash
node $SKILL_DIR/scripts/health.mjs
# ok (http://127.0.0.1:8766, sessions=N)         -> proceed
# relay not reachable at ...                     -> ask user to run `cgcon start`

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

## Handling long reviews

ChatGPT can take several minutes on large prompts. Defaults are:
- `--timeout` 600000 (10 min) end-to-end
- Long-poll chunks of 30s -- the script never busy-loops.

If the shell/agent is interrupted mid-wait, the taskId is preserved in
`~/.cgcon-v3/pending/<taskId>.json`. Recover with:

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
one task in full (prompt + reply), use the `cgcon show <taskId>` CLI if the
user has the cgcon binary installed.

## Failure modes and what to tell the user

| Symptom                                    | Root cause                             | User action                                    |
|--------------------------------------------|----------------------------------------|------------------------------------------------|
| `relay not reachable`                      | server not running                     | run `cgcon start` or `node server/index.ts`    |
| `sessions.mjs` returns `[]`                | no chatgpt.com tab active              | open chatgpt.com and confirm green banner      |
| session `paused: true, pauseReason: ...`   | captcha / rate limit / unusual activity | solve in browser; extension will auto-resume  |
| `review.mjs` exits 2, error mentions "文本注入失败" | ChatGPT frontend changed selectors     | update extension selectors                     |
| `review.mjs` exits 3 (timeout)             | reply took longer than timeout         | run `resume.mjs` later to reclaim              |
| HTTP 429 queue_full                        | too many pending tasks in this session | wait or cancel with `cgcon cancel <taskId>`    |
| HTTP 413 task_too_large                    | prompt bigger than server limit        | split the prompt                               |

## Environment variables

- `CGCON_URL` - override relay URL (default `http://127.0.0.1:8766`).
- `CGCON_PORT` - alternative to CGCON_URL, sets port on localhost.
- `CGCON_PENDING_DIR` - alt location for pending files (default
  `~/.cgcon-v3/pending`).

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
database (`~/.cgcon-v3/cgcon.db`) so tasks survive process restarts and
allow post-hoc review. Nothing leaves the user's machine except the request
to their own ChatGPT tab. If the user asks to purge history:

```bash
cgcon tasks --last 100    # to see what is there
rm ~/.cgcon-v3/cgcon.db*  # or, non-destructive: `cgcon prune` (planned)
```