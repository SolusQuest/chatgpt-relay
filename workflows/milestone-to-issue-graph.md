# Workflow: Milestone/refinement parent → relay-gated issue graph → exact publication

**Required references**:

- Relay mechanics: [`agent-instructions.md`](../agent-instructions.md)
- Effort defaults, fallback and inheritance: [Relay effort policy](./README.md#relay-effort-policy)
- Execution modes and authority boundaries: [`workflows/README.md`](./README.md#execution-modes)
- Session selection: [`workflows/README.md`](./README.md#relay-session-selection)
- Review budget, finding rules, and continuation: [`review-convergence.md`](./review-convergence.md)

## Purpose and routing

Turn an authoritative milestone design and refinement parent into a reviewed, flat GitHub issue graph, publish it idempotently, verify the remote result, and record refinement completion.

This workflow covers graph design and publication only. It does not authorize implementation, PR creation or merge, execution-issue or milestone closure, release, deployment, credential or environment mutation, or credential-bearing proof. Later implementation requires a separate invocation and authority; this workflow does not select its Relay session.

For a single issue, use [`issue-to-pr.md`](./issue-to-pr.md) for rough requirements or [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md) for a frozen contract. Do not use this workflow for materially unsettled design or when graph publication is disproportionate to the change.

## Invocation

```text
Workflow: milestone-to-issue-graph
Mode: default | auto
Milestone: <existing open milestone URL or owner/repo milestone number>
Refinement parent: <issue URL>
Design authority: <document or merged PR URL>@<exact commit SHA>
Relay session: <optional existing session ID or sessionRef>
Relay Project: <optional Project ID/name, or no-project, for a new session>
Relay effort: <optional explicit override; default pro with max fallback>
Close refinement parent: yes | no
```

Defaults are `Mode: default`, `Close refinement parent: no`, and `Relay effort: pro` with an explicit pre-send fallback to `max` under the shared effort policy. The milestone must already exist and be open; a missing or closed milestone yields the selected mode's checkpoint or `BLOCKED_HANDOFF`, without creation or reopening.

Resolve the Relay session at invocation preflight under the shared selection rule. Pin the repository, milestone, refinement parent, authority revision, mode, session ID/ref, and closure permission. Reuse that session for every unit and round; never allocate one per unit. An authority change is a material workflow change.

## Graph contract

The default structure is:

```text
refinement parent
└── tracker
    └── leaf
```

Trackers define ownership and delivery boundaries. Every leaf has exactly one tracker parent and is the smallest independently acceptable delivery unit within the pinned authority: one focused PR, an independently testable outcome and independently reversible change, path ownership, explicit dependencies, acceptance criteria/evidence, and validation commands. Once dependencies are satisfied, the outcome must be meaningful without a later leaf making it valid. Deeper execution nesting requires explicit design authority.

Split separately acceptable outcomes when dependency order preserves valid intermediate states. Shared files, implementation convenience, PR co-location, code size, and file boundaries do not justify grouping; implementation, tests, and documentation for one outcome may stay together.

Also split deterministic work from credential-bearing or external mutation, deletion families with different replacement owners or gates, work requiring multiple PRs for valid intermediate states, and shared-path work lacking an explicit handoff. Keep a tightly coupled producer and its only consumer atomic when separate delivery has no truthful usable state. Explain every retained grouping's acceptance or atomicity constraint.

### Execution parallelism and dependency rationale

Preserve meaningful independent work across the milestone within the authority, acceptance, intermediate-state, and ownership constraints. Every `blocked_by` edge must name the required predecessor result or concrete safety/ownership prerequisite. Depend on the earliest sufficient independently acceptable result rather than an entire tracker when one leaf suffices. Hierarchy, issue numbering, manifest order, and review/publication order do not establish execution dependencies. Shared paths justify blocking only when edits cannot safely be separated or assigned non-overlapping ownership.

For long serial stretches, consider narrower prerequisites, independent outcome/path boundaries, or an earlier stable common contract followed by parallel implementations and integration. Preserve the leaf rules and required validation; do not add placeholder outcomes or exceed authority to widen the graph.

The local validation report includes a concise audit using stable IDs:

- Longest blocking chain, major shared prerequisites, and integration gates.
- Meaningful parallel groups across delivery stages, their prerequisites, and shared-path or validation-resource limits. Short side branches or one wide fan-out do not establish sustained parallelism.
- Avoidable serialization corrected, reasons for remaining material bottlenecks, and significant opportunities considered but not adopted.

Mark provisional assumptions. These are structural indicators, not duration or staffing commitments. Justified low parallelism is acceptable; no minimum concurrency is required, and optional optimization remains advisory under the shared applicability rules.

### Review-field ownership and invalidation

A unit freezes its owned fields and explicitly declared frozen cross-unit dependencies. Including provisional context in a snapshot does not transfer ownership. The manifest uses this default matrix and phase-derived status, recording only provisional fields and ownership exceptions:

| Contract field | Review owner |
|---|---|
| Repository, milestone, refinement parent, authority, graph depth, tracker set | `trackers` |
| Tracker stable ID, title, native type, parent, outcome boundary, ownership envelope | `trackers` |
| Leaf stable ID, tracker parent, native type, coarse outcome, ownership envelope | `trackers` |
| Cross-tracker dependency edges and blocking reasons | `trackers` |
| Leaf title, body, detailed scope/non-goals, exact paths, acceptance, validation | `leaves:<tracker-stable-id>` |
| Intra-tracker leaf dependency edges and blocking reasons | `leaves:<tracker-stable-id>` |
| Remote identities, declared substitutions, hashes, observed topology | `final-remote-graph` as verification evidence only |

Leaf detail must stay inside the frozen coarse outcome and ownership envelope. Changing a frozen semantic field invalidates its owning unit and already-reviewed units that depend on it, including affected leaf units when tracker fields change. Context-only inclusion does not cause invalidation. Retain digest lineage, finding ledger, task IDs, and the reason; never rename a batch to obtain a new budget.

Refresh the derived parallelism audit when boundaries, dependencies, reasons, or paths change. Refreshing evidence alone does not freeze provisional fields or create a review unit. Final remote review cannot authorize semantic changes.

## Review units and convergence

Each unit has an independent three-submission budget and finding namespace under `review-convergence.md`; all units run sequentially in the pinned session.

| Unit | Exact verdicts | Finding namespace |
|---|---|---|
| `trackers` | `TRACKER_BATCH_READY` / `TRACKER_BATCH_NOT_READY` | `TRK-*` |
| `leaves:<tracker-stable-id>` | `<TRACKER_STABLE_ID>_LEAF_BATCH_READY` / `<TRACKER_STABLE_ID>_LEAF_BATCH_NOT_READY` | `LEAF-<TRACKER>-*` |
| `final-remote-graph` | `REMOTE_GRAPH_READY` / `REMOTE_GRAPH_NOT_READY` | `GRAPH-*` |

Every review identifies the unit and `reviewDigest`, includes invocation, authority/permission records, project constraint profile, and phase-specific evidence, distinguishes frozen from provisional fields, and requests the complete blocker set with stable IDs and exactly one verdict. Preserve cross-unit finding IDs in the milestone audit.

The actual Relay prompt must communicate the applicable graph contract and shared applicability, finding-lineage, and final-convergence rules; local links alone do not supply context. Tracker and leaf prompts must include the granularity and parallelism requirements, distinguishing unsupported serialization, justified low concurrency, and optional optimization. Relay mechanics and submission accounting remain in the shared references.

Freeze a unit and permit dependent publication only after its agent-owned `Decision: CONTINUE` with no open verified admissible blocker. Otherwise use the mode's checkpoint or `BLOCKED_HANDOFF`. Apply shared continuation rules when the Relay verdict is not READY; a verdict never expands publication or closure authority.

Use `<repo>-milestone-graph-<unit>-<review-digest-prefix>-r<round>` as a deterministic `clientRequestId`. Reuse it for retries of the same submission; add `-retry<n>` only when shared mechanics prove a new task safe, retaining the failed task and reason.

Active semantic corrections use the unit's remaining budget. Frozen semantic changes follow the invalidation matrix; a new cycle requires user authority in `default` or the explicit `auto` re-entry condition below. Shared rules own accounting, resets, failure classification, later findings, and the ban on a fourth unrestricted review. Declared mechanical materialization does not invalidate review.

## Auto-mode continuation

Continue deterministic, reversible, authority-preserving corrections, mechanical reconciliation, interrupted-publication recovery, and independent safe work. Unrelated remote changes, unavailable optional schema tools, and verdicts closable with authoritative evidence under shared continuation rules do not alone require a stop.

If later leaf work invalidates frozen units, withhold dependent publication and consolidate corrections into one re-entry wave. Each affected unit may receive one new bounded cycle without budget renewal only when every change:

- Preserves authority, milestone scope, tracker outcome boundaries, and user permissions.
- Is deterministic, reversible, locally validated, and included in affected snapshots.
- Does not overwrite or contradict a human semantic edit.
- Carries the existing ledger, digest/task lineage, and invalidation reason.

Finish re-entry before dependent materialization or final review. Another material invalidation after the same unit's automatic re-entry freezes, an authority conflict, ambiguous human semantic drift, absolute disagreement, destructive or credential-bearing action, or inability to verify the final graph yields one consolidated `BLOCKED_HANDOFF`. Do not ask sequential questions for independent findings.

## Review and publication artifacts

Keep a task-specific artifact directory outside issue bodies with authority/permission records, complete body sources, graph and local audits, per-unit snapshots/prompts/task IDs/replies/ledgers/revisions/verdicts/decisions, publication receipt, remote verification, and completion-comment draft/readback.

Each JSON artifact declares `schemaVersion` with the version listed below:

- **Manifest — `issue-graph/v1`**: pinned `workflowId`, repository/milestone/refinement-parent identities, authority URI and exact revision, graph constraints, ordered nodes, substitutions, and review ownership. Each node records stable ID, marker, title, native type, milestone, parent stable ID, semantic body source, direct `blocked_by` IDs and reasons reflected in that body, scope/non-goals, paths, acceptance criteria, validation summary, owning unit, and cross-unit contracts.
- **Receipt — `issue-graph-receipt/v1`**: workflow identity, source review digests, materialization digest, stable ID → repository/issue number/node ID/URL map, substitutions, last remote revisions/managed-field snapshots, attempted mutations/readbacks, and completion state. Creation intents also record object kind, stable marker, exact body hash, target repository/parent, intended title/type/milestone/parent metadata where applicable, unique intent ID, attempt state/timestamps, returned identity, and recovery evidence.
- **Verification — `issue-graph-verification/v1`**: fresh remote evidence and complete-collection pagination records supporting Phase 6 assertions.

Pin `workflowId` before review, preserve it on retry/resume, and require `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Stable IDs are independent of GitHub numbers and match `^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$`. Every managed issue has a reviewed marker such as `<!-- issue-graph-id: R4-S2 -->`. File references are repository/artifact-root-relative POSIX paths with `/`, no absolute paths or `.`/`..` segments.

Validate JSON versions, required fields, enums, identities, normalized paths, references, and digests. RFC 8785, JSON Schema, and reusable validators are recommended, not gates: a deterministic serializer, recorded method, UTF-8 without BOM, one final LF, and exact-byte hashing suffice. Persist receipt progress promptly; atomic replacement and prior-revision retention are preferred, but unavailable tooling alone does not block `auto` or waive marker recovery.

Normalize authored review files to UTF-8 without BOM and LF. Hash the ordered manifest of each submitted artifact's relative path, byte length, and SHA-256 as `reviewDigest`; task records, verdicts, and decisions name that digest.

Mechanical issue-number/URL substitution requires reviewed declarations of placeholder, target stable ID, field, and encoding. After all identities exist, generate final bodies/publication plan and `materializationDigest`, linking each file to its source review digest and substitutions in the receipt. Undeclared semantic edits require re-entry.

## Complete collection reads

Paginate to exhaustion for exact-set, uniqueness, absence, and graph-parity claims: repository marker/title matching, milestone membership, parent/child sets, `blocked_by`, reciprocal `blocking`, and final enumeration. Exclude PRs from issue matching. Deduplicate immutable identities, fail on inconsistent duplicates, and record endpoint/query, page/cursor count, item count, and terminal pagination evidence. Discard and repeat detectably changing scans.

Known identities and acknowledged/recovered objects allow direct reads; bounded discovery cannot establish exactness or absence. Fully enumerate comments for completion-marker uniqueness/absence or exact comment-set claims, then verify an acknowledged/recovered comment directly by immutable ID. Do not enumerate unrelated collections.

## Create intent and outcome recovery

Use this guard for every new managed issue and completion comment; objects without immutable identities cannot use the existing-object drift guard.

1. Persist the exact payload and a `prepared` intent before POST.
2. Immediately perform exhaustive marker lookup in repository issues or refinement-parent comments. An absent issue marker also requires exact-title bootstrap lookup. Title-only matches are collision guards and block POST until proven managed or deliberately resolved; multiple matches block.
3. Recover a unique marker match and verify body/metadata. Apply the drift guard for mechanical differences; semantic mismatch or duplicate markers never authorize another POST.
4. With no match and no earlier fence, durably record `postAttemptedAt` and `post_attempted` immediately before one POST.
5. Record acknowledged identity as `acknowledged` and read it back. Only authoritative transport/API evidence proving non-creation permits `not_created` and a corrected intent revision.
6. For missing, timed-out, or ambiguous results, record `outcome_unknown` and repeat exhaustive lookup over a bounded recovery window. A unique recovered object supplies its identity and `recovered` state.

Never repeat a fenced POST without authoritative transport/API proof of non-creation. Negative scans are insufficient. Changing payload, metadata, intent ID, or revision does not clear the same marker's fence; replacement intents inherit it.

In `auto`, continue independent safe work during recovery, withhold writes requiring the missing identity, and hand off one unresolved intent if the bounded window ends without recovery or non-creation proof.

## Pre-write remote drift guard

Apply immediately before any existing-object or relationship mutation in Phases 3–8, including closure. Once creation yields an immutable identity, this guard applies.

1. Read by identity only the affected fields and relationship sets; use complete reads for exact sets.
2. Compare `updated_at`, marker, written fields, and affected sets with the Phase 0 or last successful receipt baseline.
3. An `updated_at` change alone is not conflict. Preserve unrelated changes, record them, and refresh an unchanged managed-state baseline without invalidating review.
4. If remote state matches an interrupted recorded mutation, recover its readback/receipt without replaying the write.
5. Autonomously reconcile declared substitutions, non-managed fields, or deterministic differences matching the frozen contract. For unexpected managed semantic drift, record before/current/intended states and provenance, apply invalidation, and never overwrite conflicting or ambiguous human edits. Use the mode's checkpoint or consolidated `BLOCKED_HANDOFF`.
6. After writing, directly verify the intended delta and affected exact sets, then advance the receipt before dependent writes.

This targeted guard reduces lost-update risk; it neither supplies atomic compare-and-swap nor authorizes overwriting semantic drift.

## Phase 0 — Authority, permissions, and remote baseline

1. Confirm repository and milestone title/number/open state. Read the full refinement parent, repository instructions/templates, roadmap, architecture/contracts, and exact authority revision. Stop for unsettled material product, public-contract, compatibility, migration, security, privacy, or scope decisions.
2. Record permissions to update managed issues, add relationships, post completion, and optionally close the parent. Inspect authenticated identity and permission metadata read-only; never probe-write. In `auto`, incomplete permission proof alone does not block an authorized, idempotent, recoverable mutation; explicit denial or unsupported required operations do.
3. Verify native types and sub-issue/dependency capabilities. Check documented relationship limits when approaching them; undiscoverable limit metadata alone does not block.
4. Complete Relay preflight under the shared mechanics, including first-message context for a new session.
5. Snapshot managed issues, marker matches, milestone membership, relationships, and states before writing, with complete reads where required. Snapshot comments only for resuming/reconciling an attempted completion record.

## Phase 1 — Complete graph draft and local audit

Before publication, draft every tracker, leaf, parent edge, and dependency in the manifest. Complete tracker bodies and leaf outlines containing every tracker-owned field; those fields cannot remain provisional at tracker review. Leaf-owned detail may remain provisional.

Validate and save the complete manifest and report:

- Unique IDs/markers, valid endpoints, exactly one tracker per leaf, configured depth, and acyclic executable order.
- Complete tracker coverage, ownership/handoffs without unexplained overlap, minimum independently acceptable leaves, and justified grouping.
- Concrete dependency reasons, shared-path owners/sequencing where necessary, and the parallelism audit with provisional assumptions and justified material bottlenecks.
- No title collisions among planned issues or ambiguous remote matches; no undeclared symbolic issue-number substitutions.
- Manifest/receipt versions, fields, paths, enums, references, ownership, and canonical-digest rules under the artifact contract.

Local validation precedes Relay review and does not replace it.

## Phase 2 — Tracker batch review

Submit `trackers` with the complete graph/report, all tracker bodies, leaf outlines, and relevant templates/cross-repository contracts, plus the common review context.

Review coverage, scope, ownership envelopes, sequencing, graph validity, cross-tracker dependencies/reasons, leaf split boundaries, and milestone-wide parallelism under declared assumptions. Freeze through the shared review protocol before any tracker publication.

## Phase 3 — Tracker materialization and verification

Generate tracker bodies from frozen sources and declared substitutions. Resume known receipt mappings; otherwise create under the creation guard. Require a unique, proven managed identity in the target repository before updating it under the drift guard.

Set exact title, body, type, milestone, and refinement parent. Record immutable identity, URL, body hash, relationship result, intent state, and readback. Compare each remote body with its materialized file and verify marker, metadata, open state, and direct parent. All trackers must match before leaf publication.

## Phase 4 — Per-tracker leaf review and materialization

Process trackers in manifest order:

1. Complete all direct leaf bodies, changing only leaf-owned fields inside the frozen tracker contract.
2. Update manifest revision/local validation. Prepare a split audit mapping outcomes to leaves, focused PRs, paths, dependencies/reasons, acceptance, validation, and retained-grouping constraints. Refresh parallelism as detailed paths/dependencies replace provisional assumptions.
3. Snapshot the frozen tracker contract, complete current graph, all batch bodies, split/parallelism audits, and required cross-unit contracts.
4. Review `leaves:<tracker-stable-id>` against the frozen contract and graph rules. A required split/parallelism correction affecting frozen tracker fields, or a proven tracker/cross-tracker contradiction, is a cross-unit blocker handled by invalidation/re-entry, never a silent redesign.
5. Freeze through the shared protocol, then materialize leaves under the creation/drift guards. Set and read back exact title, body, type, milestone, tracker parent, and stable remote mapping.

Apply the complete dependency set only after every endpoint has a verified remote identity.

## Phase 5 — Graph materialization and dependency reconciliation

1. Resolve stable parent/dependency targets through the receipt; regenerate and validate the complete graph, including cycles and reciprocal `blocking` sets.
2. Generate final bodies and `materializationDigest` from frozen sources/substitutions.
3. Apply missing managed parent and `blocked_by` relationships idempotently under the drift guard, recording each write/readback before dependent work.
4. Treat extra parent, child, `blocked_by`, or `blocking` relationships as mismatches. Do not delete or overwrite unproven external relationships without explicit authority. Never remove unknown remote relationships under this workflow.

## Phase 6 — Complete remote verification

Generate the versioned verification report from fresh reads under the collection rules. For every issue verify:

- Stable marker, number, node ID, URL, title, and open state.
- Materialized body hash and source review lineage.
- Native type, milestone, direct parent, and exact managed child set.
- Exact managed `blocked_by` and reciprocal `blocking` sets.

For the full graph verify unique complete mappings, manifest node/edge counts, exact depth/flat structure, all expected managed edges, no unexpected managed edges or cycles, and the refinement parent's and milestone's pre-completion states. Include pagination evidence for every asserted collection; comment pagination is required only for exact comment-set claims. API success alone is insufficient. Correct proven mechanical errors; semantic mismatches trigger invalidation/re-entry.

Draft completion with `<!-- issue-graph-completion: <workflowId>:<materializationDigest> -->`, authority revision, review digests/tasks/verdicts/decisions, stable mapping, verification result, remaining open objects, and explicit exclusion of implementation or milestone completion. Declare final-ID substitution as mechanical; inserting the final Relay task ID must not change the marker.

## Phase 7 — Final remote graph review

Submit `final-remote-graph` with authority/permissions; frozen manifests, digests, tasks, verdicts, decisions, and ledger summary; receipt/mapping; actual topology; final parallelism audit; verification report/materialization digest; and proposed completion comment/parent transition.

Review publication lineage, graph parity/cycles/unexpected relationships, verification sufficiency, completion truthfulness, and closure authority. Parallelism checks are limited to consistency with the frozen design/audit. Do not restart design, reopen resolved findings without new authoritative evidence, or make optional optimization a publication blocker. Complete the shared convergence protocol before completion actions.

## Phase 8 — Completion record, optional parent closure, and handoff

After final continuation:

1. Insert declared final identifiers into completion and update its materialization record.
2. Repeat complete Phase 6 verification: bodies, digest, identities, and topology must match the final-reviewed graph. Handle drift before completion.
3. Persist the exact comment body hash and parent/marker create intent; run the creation guard to recover or create one comment. Read back immutable identity, rendered content, marker, hash, and URL; reconcile only declared mechanical differences under the drift guard.
4. Only with explicit `Close refinement parent: yes`, apply the drift guard, close with the intended reason, and verify state. Otherwise leave it open and report that closure was not authorized.
5. Re-read the complete milestone issue set, trackers/leaves, and managed relationship collections. Execution issues and milestone remain open; bodies and graph must still match.
6. Preserve artifacts and report counts, URLs, digests, Relay tasks/verdicts/decisions, create-intent outcomes, verification, completion comment, closure result, risks, and unresolved authority questions.

Return `ISSUE_GRAPH_PUBLISHED` or `BLOCKED_HANDOFF`. The publication session remains pinned through that terminal outcome; publication grants no implementation or milestone-completion authority.

## Safety rules

Shared execution-mode, Relay, convergence, secret-handling, and user-authority rules apply. Issue numbering, labels, and reviewer preferences never override the pinned design authority. Publish only frozen semantic units and obey creation/drift guards; never conceal a frozen-contract edit in a later batch.
