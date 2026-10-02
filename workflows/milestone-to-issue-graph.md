# Workflow: Milestone/refinement parent → relay-gated issue graph → exact publication

**Required references**:

- Relay mechanics: [`agent-instructions.md`](../agent-instructions.md)
- Execution modes and authority boundaries: [`workflows/README.md`](./README.md#execution-modes)
- Session selection: [`workflows/README.md`](./README.md#relay-session-selection)
- Review budget, finding rules, and continuation: [`review-convergence.md`](./review-convergence.md)
- Downstream implementation: [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md)

---

## Purpose and routing

Use this workflow to turn an authoritative milestone design and refinement parent into a reviewed, flat tracker-and-leaf GitHub issue graph, publish that graph idempotently, verify the actual remote topology and bodies, and record completion of the refinement work.

This workflow owns issue-graph design and publication only. It does not implement leaves, create or merge PRs, close execution issues or the milestone, perform releases or deployments, mutate credentials or environments, or execute credential-bearing proof. A published leaf may later enter `agent-ready-issue-to-pr.md` through a separate invocation and authorization.

Use `issue-to-pr.md` for one rough implementation issue and `agent-ready-issue-to-pr.md` for one frozen implementation contract. Do not use this workflow when the design authority is still materially unsettled, when the intended result is not a multi-issue graph, or when the publication overhead is disproportionate to a small independent change.

## Invocation

```text
Workflow: milestone-to-issue-graph
Mode: default | auto
Milestone: <existing open milestone URL or owner/repo milestone number>
Refinement parent: <issue URL>
Design authority: <document or merged PR URL>@<exact commit SHA>
Relay session: <optional existing session ID or sessionRef>
Relay Project: <optional Project ID/name, or no-project, for a new session>
Close refinement parent: yes | no
```

If mode is omitted, use `default`. If `Close refinement parent` is omitted, use `no`. The target milestone must already exist and be open. Milestone creation is outside this workflow; a missing or closed target milestone yields the selected mode's checkpoint or `BLOCKED_HANDOFF`.

Resolve the Relay session at invocation preflight using the shared session-selection rule. Pin the repository, milestone, refinement parent, design authority, mode, Relay session, and closure permission for the entire workflow. Use that one Relay session for every tracker review, leaf-batch review, final-graph review, and convergence round. Never allocate or select a separate session per review unit. A later authority change is a material workflow change, not an editorial correction.

## Graph contract

The default graph has two execution levels beneath the refinement parent:

```text
refinement parent
└── tracker
    └── leaf
```

Trackers group ownership and delivery boundaries. Leaves remain direct children of exactly one tracker. Each leaf must be the smallest independently acceptable delivery unit within the pinned design authority and represent one focused PR with an independently testable outcome, an independently reversible change, declared path ownership, explicit dependencies, acceptance criteria, and validation commands. Once its declared dependencies are satisfied, a leaf must deliver one meaningful outcome with explicit acceptance evidence, without requiring a later leaf to make that outcome valid. Do not create deeper execution nesting unless the user-authorized design authority explicitly requires it.

Split a proposed leaf whenever it contains two or more separately acceptable outcomes that can be delivered in dependency order while preserving valid intermediate states. Express sequencing through dependency edges. Shared files, implementation convenience, or fitting into one PR are not sufficient reasons to combine outcomes. Required implementation, tests, and documentation for the same outcome may remain together; code size and file boundaries do not define independent outcomes.

Also split a proposed leaf when it combines deterministic implementation with credential-bearing or external mutation, mixes deletion families with different replacement owners or gates, requires multiple PRs to keep intermediate states valid, or shares paths without an explicit handoff order. Keep tightly coupled producer-and-only-consumer work atomic when separate delivery would not create a truthful usable state. When retaining a grouping of candidate outcomes, explain the acceptance or atomicity constraint that prevents further splitting.

The graph manifest is the versioned JSON source of truth for publication. Its top-level object records at least `schemaVersion`, a stable `workflowId`, repository identity, target milestone identity, refinement-parent identity, design-authority URI and exact revision, graph constraints, ordered nodes, declared substitutions, and review-unit ownership. Use `issue-graph/v1` as the initial schema version. Pin `workflowId` before the first review, preserve it across retries and resumes, and restrict it to `^[A-Za-z0-9][A-Za-z0-9._-]*$` so it is safe inside the completion marker.

Each node records at least:

- Stable ID and stable hidden body marker.
- Title, native issue type, milestone, and direct parent stable ID.
- Semantic body source.
- Direct `blocked_by` stable IDs.
- Scope, non-goals, path ownership, acceptance criteria, and validation summary.
- Owning review unit and any cross-unit contract dependencies.

Stable IDs never depend on GitHub issue numbers and match `^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$`. Use a reviewed hidden marker such as `<!-- issue-graph-id: R4-S2 -->` in every managed body. The completion comment uses `<!-- issue-graph-completion: <workflowId>:<materializationDigest> -->` as its stable creation and recovery marker. Semantic body sources and other file references use repository- or artifact-root-relative POSIX paths with `/`; absolute paths, `.` segments, and `..` segments are invalid.

The publication receipt is a separate versioned JSON document whose `schemaVersion` is `issue-graph-receipt/v1`. It records the workflow identity, source review digests, materialization digest, stable ID to repository/issue number/node ID/URL mapping, declared substitutions, the last observed remote revision and managed-field snapshot, every attempted mutation and readback, and completion state. For every issue or completion-comment creation it also records a durable create intent containing the object kind, marker, exact body hash, repository and parent identity, intended title/type/milestone/parent fields where applicable, attempt state, timestamps, returned identity, and recovery evidence. Exact-title lookup is only a bootstrap fallback and multiple matches are a hard failure.

The manifest and receipt must remain valid JSON with their declared `schemaVersion`, stable identities, references, digests, and publication mapping. RFC 8785 canonicalization, a repository-pinned JSON Schema, and a reusable validator are recommended consistency tools, not execution gates. When those tools are unavailable, use one deterministic serializer for the entire workflow, encode UTF-8 without BOM with one final LF, hash the exact stored bytes, record the serialization method, and validate the required fields, enums, IDs, paths, and references. Persist receipt progress promptly after remote mutations; atomic replacement and retention of the previous revision are preferred when the environment supports them, but their absence alone does not block `auto` execution because stable-marker recovery remains mandatory.

### Review-field ownership and invalidation

The graph manifest identifies the semantic review owner of every field. A complete manifest may appear in several review snapshots, but a unit freezes only the fields it owns plus cross-unit fields explicitly declared as frozen dependencies. Context-only provisional fields do not become tracker-owned merely because they were included in the tracker snapshot.

| Contract field | Review owner |
|---|---|
| Repository, milestone, refinement parent, design authority, graph depth, and tracker set | `trackers` |
| Tracker stable ID, title, native type, parent, outcome boundary, and ownership envelope | `trackers` |
| Leaf stable ID, tracker parent, native type, coarse outcome, and ownership envelope | `trackers` |
| Exact cross-tracker dependency edges | `trackers` |
| Leaf title, semantic body, detailed scope and non-goals, exact paths, acceptance criteria, and validation commands | `leaves:<tracker-stable-id>` |
| Dependency edges whose endpoints are both leaves of the same tracker | `leaves:<tracker-stable-id>` |
| Remote issue identities, declared substitutions, materialized hashes, and observed remote topology | `final-remote-graph` as verification evidence only |

A leaf unit may refine its owned fields without invalidating `trackers` only while the result remains inside the frozen coarse outcome and ownership envelope. Changing a leaf identity, parent, type, coarse outcome, ownership envelope, or cross-tracker edge invalidates `trackers` and every already-reviewed affected leaf unit. Changing an intra-tracker edge or another leaf-owned field invalidates that leaf unit and any already-reviewed unit that declared it as a frozen dependency. `final-remote-graph` never owns product semantics and cannot authorize a scope, ownership, acceptance, or dependency change.

## Review units and convergence

Every Relay review in this workflow follows `review-convergence.md`. The workflow defines these independent bounded artifact review units:

1. `trackers` — the complete tracker batch.
2. `leaves:<tracker-stable-id>` — all leaves directly owned by one tracker.
3. `final-remote-graph` — the fully materialized and verified remote graph plus the proposed completion action.

Each review unit has its own three-submission convergence budget and finding-ledger namespace. Work in one unit does not consume another unit's budget. `review-convergence.md` exclusively owns submission accounting, reset rules, failure classification, later-finding treatment, and the prohibition on a fourth unrestricted review.

Review-unit separation is only an artifact, budget, and ledger boundary. All units run sequentially through the single pinned Relay session from the invocation.

Use stable finding IDs scoped to the unit, for example `TRK-B001`, `LEAF-HOST-B001`, and `GRAPH-B001`. Carry cross-unit findings into the milestone-level audit record without renaming their original IDs.

Each unit produces both an artifact-specific Relay verdict and the agent-owned continuation record required by `review-convergence.md`. Publication requires `Decision: CONTINUE` with no open agent-verified admissible blocker; apply the shared continuation rules when the final Relay verdict is not READY.

Use a deterministic `clientRequestId` such as `<repo>-milestone-graph-<unit>-<review-digest-prefix>-r<round>`. Reuse that exact key for client or network retries of the same submission. Only after the shared Relay mechanics establish that creating a new task is safe may an explicit retry add `-retry<n>`; retain the failed task ID and reason in the audit record.

A semantic change to an active unit uses that unit's remaining budget. After a unit is frozen, a semantic change invalidates its review digest and every dependent unit that owned the field or declared it as a frozen cross-unit dependency; context-only inclusion does not create invalidation. Apply the review-field ownership matrix, and do not relabel the change as a new batch to obtain another budget. In `default`, a new full cycle requires direct user authorization. In `auto`, the consolidated re-entry condition below is an explicit workflow-defined new-cycle condition under `review-convergence.md`. Always retain the prior ledger, digests, task IDs, and reason for reopening. Mechanical materialization defined below does not invalidate review.

## Auto-mode continuation

In `auto`, do not stop for deterministic, reversible, authority-preserving corrections; mechanical drift reconciliation; recovery of an interrupted publication; non-managed remote changes; unavailable optional schema/canonicalization tooling; or a Relay verdict that the shared continuation protocol permits the agent to close with authoritative evidence.

When later leaf work invalidates one or more frozen units, finish independent safe drafting and review, withhold publication that depends on an invalid unit, and collect all related corrections into one consolidated re-entry wave. The agent may start one new bounded convergence cycle for each affected unit without requesting review-budget renewal when every change:

- Preserves the pinned design authority, milestone scope, tracker outcome boundaries, and user-owned permission limits.
- Is deterministic, reversible, and covered by local validation and the affected review snapshots.
- Does not overwrite or contradict a human semantic edit on GitHub.
- Carries the existing finding ledger, digest lineage, prior task IDs, and invalidation reason into the reopened unit.

Complete the re-entry wave before dependent materialization or final-graph review. If the same unit is materially invalidated again after its automatic re-entry cycle has completed and frozen, or the required change crosses an authority boundary, conflicts with a human semantic edit, creates an absolute disagreement, requires destructive or credential-bearing action, or prevents exact final-graph verification, return one consolidated `BLOCKED_HANDOFF`. Do not ask sequential questions for independent findings that can be reported together.

## Review and publication artifacts

Store visible workflow artifacts in a task-specific working directory outside the issue bodies. Preserve at least:

- Authority record and permission record.
- Graph manifest and local validation report.
- Complete tracker and leaf body sources.
- Per-unit review snapshot manifest, Relay prompts, task IDs, replies, finding ledger, revision summary, verdict, and continuation decision.
- Publication receipt and stable-ID materialization map.
- Remote verification report.
- Completion comment draft and final readback.

Normalize authored review files to UTF-8 without BOM and LF line endings before hashing. For every review submission, generate a manifest containing the ordered relative path, byte length, and SHA-256 of every submitted artifact, then hash that manifest as the unit `reviewDigest`. Relay task records, verdicts, and continuation decisions must name the reviewed digest.

Issue-number and URL replacement is mechanical only when the reviewed source explicitly declares the placeholder, target stable ID, replacement field, and encoding. After all stable IDs have remote identities, generate the final bodies and publication plan from that declared map and record their hashes in a `materializationDigest`. The publication receipt links each materialized file back to its source `reviewDigest` and substitution entries. Any undeclared prose, scope, dependency, acceptance, or ownership change is semantic and must re-enter the affected review unit.

## Complete collection reads

Paginate to exhaustion whenever the workflow makes an exact-set, uniqueness, absence, or full-graph-parity claim. This is mandatory for repository-wide stable-marker or exact-title bootstrap matching, milestone issue sets, refinement-parent children, sub-issues, `blocked_by`, reciprocal `blocking`, and final managed-graph enumeration. Follow every REST page or GraphQL cursor until the API reports no next page; never treat one response or a maximum page size as the complete set.

Known issue numbers, node IDs, URLs, and acknowledged or recovered mutation identities may be read directly without enumerating unrelated collections. Comments require full pagination for the completion-marker uniqueness/absence check or another exact comment-set claim; after acknowledgement or recovery, the completion comment is verified directly through its immutable comment ID. Bounded discovery reads are allowed when they do not support an exact or absence claim.

Issue enumeration must distinguish issues from pull requests and exclude pull requests from marker and title matching. For every required complete read, deduplicate by immutable remote identity, fail on inconsistent duplicates, and record the endpoint or query, page or cursor count, item count, and terminal pagination evidence in the audit artifacts. If a collection changes detectably during pagination, discard that scan and repeat it before making an exact-set decision.

## Phase 0 — Authority, permissions, and remote baseline

Before drafting or mutating GitHub:

1. Confirm the repository and existing target milestone, verify that the milestone is open, and read back its title and number. Do not create or reopen a milestone in this workflow.
2. Read the complete refinement parent, repository instructions, issue templates, roadmap, architecture and contract sources, and the exact design-authority revision.
3. Confirm that the authority settles the milestone boundary well enough to define trackers, leaves, dependencies, acceptance, and non-goals. If a material product, public-contract, compatibility, migration, security, privacy, or scope decision is missing, stop under the selected mode instead of inventing it.
4. Record whether the workflow may update existing managed issues, add graph relationships, post the completion record, and close the refinement parent. Closure remains unauthorized unless `Close refinement parent: yes` was explicit.
5. Read the repository's supported native issue types and confirm every manifest type is available.
6. Confirm that the required sub-issue and dependency operations are available for the repository. Check documented platform relationship limits when the manifest approaches a known limit; absence of discoverable limit metadata alone is not a blocker.
7. Inspect the current authenticated identity and available repository permission metadata through read-only evidence. Do not perform a probe write. In `auto`, inability to prove every fine-grained permission in advance is not itself a blocker when the intended mutation is authorized, idempotent, and recoverable; an explicit denial or unsupported required operation blocks the affected publication phase and joins the consolidated handoff.
8. Apply the shared session-selection rule early, pin the selected ID/ref, and follow `agent-instructions.md` for Relay preflight and any new session's first-message context.
9. Snapshot existing managed issues, stable-marker matches, milestone membership, parent-child relationships, dependencies, and state before the first write using complete reads where an exact set is required. Snapshot comments only when resuming or reconciling a previously attempted completion record.

## Phase 1 — Complete graph draft and local audit

Draft the complete stable-ID graph before publishing any node. The graph manifest includes all trackers, all intended leaves, every parent edge, and every dependency edge even when detailed leaf bodies will be reviewed later per tracker. The ownership matrix supplies the default owner and phase-derived status; the manifest records only provisional fields and ownership exceptions rather than annotating every field. Tracker-owned fields cannot remain provisional when the tracker unit is submitted.

Draft all tracker bodies and enough leaf outlines to audit tracker coverage and ownership. A leaf outline contains every tracker-owned leaf field, including the coarse outcome and ownership envelope; leaf-owned detail may remain provisional until its leaf unit. Then validate locally:

- Stable IDs and hidden markers are unique.
- Every parent and dependency endpoint exists in the manifest.
- Every leaf has exactly one tracker parent and the configured maximum depth is respected.
- The dependency graph is acyclic and has an executable order.
- Tracker coverage has no unowned leaf and no overlapping responsibility without an explicit handoff.
- Every leaf satisfies the smallest independently acceptable unit, focused-PR, and split rules; any retained grouping of candidate outcomes has a concrete acceptance or atomicity reason.
- Shared paths have a declared owner and sequencing edge where required.
- Titles do not collide with each other or with multiple remote issues.
- Bodies contain no undeclared symbolic GitHub issue-number substitutions.
- The manifest and any existing receipt satisfy their versioned contract, reference integrity, normalized-path, enum, field-ownership, and canonical-digest rules.

Local validation is a precondition for Relay review, not a substitute for it. Save the complete manifest and validation result in the review artifacts.

## Phase 2 — Tracker batch review

The `trackers` review snapshot contains:

- Invocation, authority record, project constraint profile, and permission record.
- Complete graph manifest with explicit field ownership/status and the local validation report.
- Complete tracker bodies.
- All leaf outlines needed to evaluate tracker coverage, overlap, leaf granularity, and split boundaries.
- Relevant issue templates and cross-repository contracts that materially constrain publication.

The Relay prompt must identify the exact review unit and `reviewDigest`; distinguish tracker-owned frozen fields from leaf-owned provisional context; request stable blocker IDs; require a complete review of tracker coverage, scope, ownership envelopes, sequencing, graph validity, cross-tracker dependencies, and leaf partitioning into the smallest independently acceptable units under the split rules; and return exactly one artifact-specific verdict:

```text
TRACKER_BATCH_READY
TRACKER_BATCH_NOT_READY
```

The actual prompt sent to Relay must also communicate the shared applicability, finding-lineage, and final-convergence contract sufficiently for the remote reviewer; a local Markdown link alone is not context. Do not duplicate the Relay task lifecycle or agent continuation rules in this workflow.

Run the unit through the shared three-round convergence protocol. When the continuation decision is `CONTINUE`, freeze the tracker review snapshot and digest. Otherwise return the selected mode's checkpoint or `BLOCKED_HANDOFF` without publishing trackers.

## Create intent and outcome recovery

Object creation has no immutable remote identity before POST and therefore does not use the existing-object drift guard as its precondition. Apply this at-most-once creation guard to every managed issue and completion comment:

1. Materialize the exact create payload and persist a create intent in the receipt before POST. The intent starts as `prepared` and includes the stable marker, exact body hash, target repository and parent, intended metadata, and a unique local intent ID.
2. Immediately perform an exhaustive marker lookup in the target collection. Issue creation scans repository issues and excludes pull requests; completion-comment creation scans every comment page on the refinement parent. When an issue marker is absent, also perform the exhaustive exact-title bootstrap fallback. A title-only match is a collision guard, not proof of the intended creation, and blocks POST until it is proven managed or deliberately resolved.
3. If exactly one marker match exists, record its immutable identity and recover instead of posting. Verify its body and metadata. Reconcile declared mechanical differences through the existing-object drift guard; a semantic mismatch or duplicate marker is a conflict and never authorizes another POST.
4. If no match exists and no earlier POST fence exists for the intent, durably set `postAttemptedAt` and state `post_attempted` immediately before issuing one POST.
5. On an acknowledged response, record the returned immutable identity, set `acknowledged`, and perform direct readback. On an authoritative rejection proving that no object was created, set `not_created`; a corrected payload may create a new intent revision.
6. If the POST result is missing, times out, or is otherwise ambiguous, set `outcome_unknown` and repeat exhaustive marker lookup over a bounded recovery window. A recovered marker changes the state to `recovered` and supplies the immutable identity.
7. Never issue a second POST for an intent with a POST fence until authoritative transport or API evidence proves non-creation. Absence from one or more marker scans is observation evidence, not by itself proof that the request was never accepted.

Changing the body, metadata, local intent ID, or intent revision never clears an earlier POST fence for the same stable marker. A replacement intent inherits the unresolved fence until the earlier outcome is recovered or non-creation is proven.

In `auto`, preserve the unresolved intent and continue independent safe work while recovery remains possible. Do not perform dependent writes that require the missing identity. If the bounded recovery window ends without either a recovered identity or proof of non-creation, include the single unresolved intent in the consolidated `BLOCKED_HANDOFF`; never resolve uncertainty by duplicate creation.

## Pre-write remote drift guard

Apply this guard immediately before every mutation of an existing GitHub object or relationship in Phases 3 through 8, including issue updates, parent or dependency changes, completion-comment updates, and optional refinement-parent closure. New issues and new comments use the creation guard above until they have an immutable identity.

1. Read the target by immutable identity and read only the fields and relationship collections affected by the proposed mutation. Paginate a relationship collection when the mutation depends on its exact current set.
2. Compare `updated_at`, the stable marker, every field being written, and any affected relationship set with the Phase 0 baseline or the receipt's last successful readback. Do not fetch or compare unrelated comments or relationship collections merely because they exist.
3. Treat an `updated_at` change as a drift signal, not proof of conflict. If the affected managed state is unchanged, preserve unrelated remote changes, record the observation, refresh the receipt baseline, and continue without invalidating review.
4. If the remote state exactly matches a previously recorded workflow mutation whose receipt update was interrupted, complete that mutation's readback and receipt recovery without replaying the write.
5. Reconcile autonomously when the difference is a declared mechanical substitution, a non-managed field, or another deterministic state that already matches the frozen contract. Otherwise, do not overwrite unexpected managed semantic drift. Record the before/current/intended states and provenance evidence; invalidate the owning review unit when appropriate. A conflicting or ambiguous human semantic edit yields the selected mode's checkpoint or one consolidated `BLOCKED_HANDOFF` in `auto`.
6. After an authorized write, directly read back the changed object and any affected exact relationship set, prove that the delta is the intended mutation, and advance the receipt promptly before issuing another dependent write.

The guard narrows lost-update risk but does not claim an atomic remote compare-and-swap when the platform offers none. Its purpose is safe autonomous continuation, not a full remote audit before every write; never convert a targeted comparison into permission to overwrite an unexpected semantic edit.

## Phase 3 — Tracker materialization and verification

Generate materialized tracker bodies from the frozen sources and declared substitution map. Publish with an idempotent stable-ID strategy:

1. Resume from the publication receipt when a mapping already exists, applying the pre-write drift guard before any further mutation.
2. When no mapping exists, materialize and persist the tracker create intent, then run the complete creation guard before one allowed POST.
3. Fail on duplicate markers, multiple title matches, repository mismatch, or an existing issue that cannot be proven to be workflow-managed. Recover a unique matching creation into the receipt instead of posting again.
4. Once an immutable issue identity is acknowledged or recovered, apply the drift guard and set the exact native type, milestone, refinement-parent relationship, title, and materialized body.
5. Record the issue number, node ID, URL, body hash, relationship result, create-intent state, and readback before proceeding.

Read every tracker back and compare the remote body with the materialized file, then verify marker, title, state, native type, milestone, and direct parent. Do not begin leaf publication while the tracker batch has an unresolved mismatch.

## Phase 4 — Per-tracker leaf review and materialization

Process trackers in the manifest's declared order. For each tracker:

1. Draft the complete bodies for all of its direct leaves.
2. Fill only fields owned by `leaves:<tracker-stable-id>`, preserve every frozen tracker-owned field, update the manifest revision and local graph validation, and prepare a split audit mapping tracker outcomes to leaves, focused PRs, path owners, dependencies, acceptance criteria, and validation commands. Include any acceptance or atomicity constraint used to justify keeping candidate outcomes together.
3. Build the `leaves:<tracker-stable-id>` review snapshot with the frozen tracker contract, complete current graph manifest, all leaf bodies in the unit, the split audit, and every cross-unit contract required to judge them.
4. Generate and record the unit `reviewDigest`.
5. Ask Relay to review the leaf-owned fields against the frozen tracker outcome and ownership envelope and recheck leaf granularity against the smallest independently acceptable unit and split rules. It must report a required split that changes frozen tracker-owned fields, or any other proven tracker-owned or cross-tracker contradiction, as an explicit cross-unit blocker rather than silently redesigning the tracker contract. Request the complete blocker set with stable unit-scoped IDs and exactly one verdict:

```text
<TRACKER_STABLE_ID>_LEAF_BATCH_READY
<TRACKER_STABLE_ID>_LEAF_BATCH_NOT_READY
```

6. Apply the shared three-round convergence protocol and freeze the unit only after `Decision: CONTINUE` with no verified blocker.
7. Materialize the frozen leaves idempotently: missing leaves use the same create-intent and outcome-recovery guard as trackers, while acknowledged, recovered, or existing leaves use the pre-write drift guard. Set their exact type, milestone, tracker parent, title, body, and stable mapping, then read those fields back.

Do not silently change a frozen tracker or earlier leaf batch because a later batch exposes a semantic conflict. Apply the review-unit invalidation and re-entry rule. Cross-batch issue-number and URL replacement remains mechanical only when it was declared in the reviewed substitution map.

Dependency edges may be recorded in the manifest throughout this phase, but apply the complete dependency set only after every endpoint has a verified remote identity.

## Phase 5 — Graph materialization and dependency reconciliation

After all nodes exist and their node-level metadata is verified:

1. Resolve every stable parent and dependency target through the publication receipt.
2. Regenerate and validate the complete materialized graph before mutation, including cycle detection and expected reciprocal `blocking` sets.
3. Compute the final materialized bodies and `materializationDigest` from the frozen sources and declared substitutions.
4. Apply missing workflow-owned parent and `blocked_by` relationships idempotently under the pre-write drift guard.
5. Treat any unexpected extra parent, child, `blocked_by`, or `blocking` relationship as a mismatch. Do not delete or overwrite an unproven external relationship without explicit authority.
6. Record each write and readback in the publication receipt so interruption can resume without duplicate creation or relationship mutation.

## Phase 6 — Complete remote verification

Generate a versioned JSON verification report with `schemaVersion` set to `issue-graph-verification/v1` from fresh remote reads. Use complete collection reads for every exact-set graph assertion. The report includes pagination evidence for every enumerated issue, sub-issue, dependency, and reciprocal dependency collection; include comment pagination only when making an exact comment-set claim. For every managed issue, verify:

- Stable marker, issue number, node ID, URL, title, and open state.
- Exact materialized body hash and source review lineage.
- Native type and milestone.
- Direct parent and exact managed direct-child set.
- Exact managed `blocked_by` set and reciprocal `blocking` set.

For the full graph, verify:

- Stable-ID mappings are complete and unique.
- Node and relationship counts match the manifest.
- Maximum depth and flat tracker-leaf structure are exact.
- No dependency cycle exists.
- Every expected managed edge exists and no unexpected managed edge exists.
- The refinement parent and milestone remain in their pre-completion states.

An API success response is not completion evidence. Correct only proven mechanical publication errors without changing frozen semantics. A semantic mismatch invalidates the affected review unit and follows its re-entry rule.

Draft the completion comment from the verified report and include the stable `<!-- issue-graph-completion: <workflowId>:<materializationDigest> -->` marker. The comment records authority revision, review-unit digests, Relay task IDs and verdicts, continuation decisions, stable-ID mapping, verification result, remaining open objects, and explicit non-authorization of implementation or milestone completion. The marker is part of the final review snapshot and does not change when the final Relay task ID is inserted mechanically.

## Phase 7 — Final remote graph review

The `final-remote-graph` review snapshot contains:

- Authority and permission records.
- Frozen unit manifests, digests, Relay task IDs, verdicts, continuation decisions, and finding-ledger summary.
- Stable-ID to remote-identity publication receipt.
- Complete actual parent-child and dependency topology.
- Remote verification report and `materializationDigest`.
- Proposed completion comment and proposed refinement-parent state transition.

This unit reviews the actual remote result. It checks publication lineage, graph parity, cycles, unexpected relationships, verification sufficiency, completion-record truthfulness, and closure authority. It must not restart tracker or leaf design, reopen resolved findings without new authoritative evidence, or treat optional execution improvements as publication blockers.

Request stable `GRAPH-*` blocker IDs and exactly one verdict:

```text
REMOTE_GRAPH_READY
REMOTE_GRAPH_NOT_READY
```

Apply the shared three-round convergence protocol. Continue only with `Decision: CONTINUE` and no open verified blocker. A Relay verdict does not itself authorize comment publication or closure beyond the recorded permission.

## Phase 8 — Completion record, optional parent closure, and handoff

After final continuation:

1. Mechanically insert the final Relay task ID and any other declared final identifiers into the completion comment and update its materialization record.
2. Re-run the complete Phase 6 verification and require the same managed bodies, materialization digest, identities, and topology reviewed by `final-remote-graph`. Any drift blocks completion and follows the drift or semantic-invalidation rules.
3. Compute the exact final comment body hash and persist a completion-comment create intent containing the refinement-parent identity and `<!-- issue-graph-completion: <workflowId>:<materializationDigest> -->` marker.
4. Run the complete creation guard. Recover one existing marker match instead of posting; otherwise fence and issue at most one comment POST. An ambiguous result remains pending until marker recovery or proof of non-creation and never authorizes a duplicate completion comment.
5. Read the acknowledged or recovered comment directly by immutable identity and verify its rendered content, marker, body hash, and URL. Reconcile only declared mechanical differences through the existing-object drift guard.
6. If and only if `Close refinement parent: yes` was explicit, apply the pre-write drift guard, close that parent with the intended reason, and read back its state. Otherwise leave it open and report that closure was not authorized.
7. Re-read the complete milestone issue set, every tracker and leaf, and all managed relationship collections. Confirm that execution issues and the milestone remain open and that graph relationships and bodies still match the verified manifest.
8. Preserve the complete audit artifacts and report the final counts, URLs, digests, Relay tasks and verdicts, continuation decisions, create-intent outcomes, verification result, completion comment, closure result, risks, and any answered-but-unresolved authority question.

The terminal outcome is `ISSUE_GRAPH_PUBLISHED` or `BLOCKED_HANDOFF`. Publication does not start implementation. The single pinned Relay session belongs to this publication workflow through its terminal outcome. Any later leaf implementation is outside this workflow and requires a separate `agent-ready-issue-to-pr.md` invocation and implementation authority; this workflow does not allocate or select sessions for that future work.

## Safety rules

All shared execution-mode, Relay, convergence, secret-handling, and user-authority rules remain in force. In addition:

- Never infer graph authority from issue numbering, labels, or a Relay preference when the design authority says otherwise.
- Never publish a partial semantic batch before its review unit reaches `Decision: CONTINUE`.
- Never use a later batch to conceal a semantic edit to a frozen earlier batch.
- Never repeat an issue or completion-comment POST after its durable create fence unless non-creation is proven.
- Never remove unknown remote relationships, close execution issues, close the milestone, implement leaves, or merge PRs under this workflow.
