# Merge duplicate claims and resolve related conflicts

> **Status: implemented behavior.** Claim-to-claim comparison and merge are
> available; extraction review items remain deliberately separate.

## 1. Goal

When two claims may describe the same profile fact, help the candidate produce
one authoritative claim without publishing unreviewed extraction, losing
source evidence, or silently choosing between contradictory values.

This design covers the claim consolidation and conflict-detection requirements
in `FR-AN-07`, `FR-CD-01` through `FR-CD-05`, `FR-CD-09`, `FR-CD-11`,
`FR-CD-12`, and `FR-PM-06`.

## 2. MVP scope

The MVP compares two claims owned by the same candidate and having the same
claim type. It supports:

- pending extracted claim + pending extracted claim;
- accepted claim + pending extracted claim;
- accepted claim + accepted claim; and
- manual or candidate-edited claim + extracted claim.

Discovery and proposal generation remain pairwise. The review UI may assemble
connected proposals into a workspace and let the candidate explicitly select
two or more claims for one group merge. A confirmed group is applied atomically
to one survivor; unrelated selected actions remain independent.

The MVP does not merge extraction review items, infer a claim type, or change
the global normalization dictionary. Group eligibility is derived from the
existing pair comparisons rather than a separate multi-way comparison model.
A review item continues through its existing resolve or dismiss flow; once
resolution creates a claim, a later claim comparison may include it.

## 3. Invariants

1. **Uncertain extraction is staged.** Extracted claims that do not meet the
   extraction module's automatic-acceptance criteria start as `pending` and are
   excluded from profile export. Duplicate handling must not make those claims
   visible without candidate confirmation.
2. **Resolution is approval.** When the candidate explicitly confirms the
   final values of a duplicate or conflict, the surviving claim becomes
   `accepted` and is exported. A second approval step is not required.
3. **Safe automatic work is published with an acknowledgment.** Equivalent
   pairs with no unresolved fields can auto-merge when both are unedited
   pending extracted claims, or when an accepted/auto-accepted survivor can
   safely absorb an unedited pending enrichment. The survivor becomes
   `auto_accepted`, is exported, and receives a durable merge notice. All
   uncertain work stays staged.
4. **Candidate decisions have precedence.** Candidate-entered and
   candidate-edited values are authoritative over extracted values.
5. **Completeness is only a tie-breaker.** A populated optional field or a
   more precise date wins automatically only when the values are compatible
   and have equal authority.
6. **Conflicts are not guessed away.** Incompatible populated values require
   the candidate to select or enter the final value.
7. **Provenance survives.** A merge retains the original claims, revisions,
   extraction metadata, and physical source occurrences needed for audit.
8. **One confirmation, one atomic result.** Applying a merge and retiring its
   duplicate claims succeeds or fails in one transaction.
9. **Concurrent edits are refused.** The merge is conditional on the versions
   the candidate reviewed; a changed claim returns `409 VERSION_CONFLICT`.

The existing `origin` remains provenance: editing an extracted claim must not
rewrite its origin to `manual` or discard extraction metadata. Implementation
needs a separate candidate-authority marker, such as `candidate_edited_at`, so
an edited extracted claim can take precedence while retaining its source.

## 4. Duplicate detection

Duplicate detection has two distinct outcomes:

- **same claim:** strong evidence says both records describe one fact; and
- **suspected duplicate:** the records may describe one fact, but identity is
  uncertain or their values conflict.

Only claims of the same type are candidates. Approved normalized values should
be compared when available; otherwise compare normalized original values.
Formatting normalization may ignore Unicode representation, case, surrounding
or repeated whitespace, and array order. It must not erase punctuation or
meaningful values merely to obtain a match.

Identity uses stable identifying fields rather than every optional field:

| Claim type | Initial identity evidence |
| --- | --- |
| Skill | normalized skill name |
| Language | normalized language name |
| Certification | normalized title and issuer |
| Employment | employer, job title, and overlapping or compatible dates |
| Education | institution, degree, field of study, and compatible dates |
| Project | project name plus compatible organization, URL, or dates when present |

A missing optional field neither proves nor disproves identity. A mismatch in
an identifying field produces a suspected duplicate rather than an automatic
merge unless an approved normalization establishes equivalence.

For employment and education, suspected duplicates whose start and end
boundaries are each within 12 months receive a bounded AI identity check. The
AI sees only the two structured claims and decides whether they may remain a
merge candidate. A confident negative suppresses the suggestion; a positive,
uncertain, invalid, or unavailable AI result never auto-merges claims and
leaves the final decision with the candidate. Results are cached by claim
version for the lifetime of the API process to avoid repeated model calls.

## 5. Authority and survivor selection

Value precedence is:

1. candidate-entered or candidate-edited;
2. accepted extracted;
3. pending extracted; and
4. completeness and date precision, only between compatible values at the
   same authority.

The survivor is selected independently from individual field values:

| Pair | Survivor and status |
| --- | --- |
| Pending + pending | Oldest claim is the stable survivor and becomes `auto_accepted` when safely auto-merged |
| Accepted + pending | Accepted claim survives; safe unedited enrichments become `auto_accepted` |
| Accepted + accepted | Candidate chooses the survivor; no automatic retirement |
| Candidate-authoritative + extracted | Candidate-authoritative claim survives |

Choosing a survivor does not automatically choose all of its field values.
The merge proposal applies the field rules below and shows every unresolved
choice to the candidate.

## 6. Field merge rules

Each field is classified as `same`, `enrichment`, `precision_improvement`, or
`conflict`.

| Inputs | Classification | Proposed value |
| --- | --- | --- |
| Same normalized value | `same` | Higher-authority representation, otherwise survivor value |
| Populated + absent | `enrichment` | Populated value, unless the absent field was explicitly cleared by the candidate |
| `2020` + `2020-03` | `precision_improvement` | `2020-03` |
| `2020-03` + `2020-03` | `same` | `2020-03` |
| `2020-03` + `2020-04` | `conflict` | Candidate choice required |
| `2020` + `2021-03` | `conflict` | Candidate choice required |
| Equivalent arrays | `same` | Deduplicated normalized array |
| Compatible additive arrays | `enrichment` | Stable union without duplicates |
| Different scalar text | `conflict` | Candidate choice required |

A year and year-month are compatible only when their years match. Date ranges
are evaluated field by field and must still satisfy the claim's date-order
validation after merging. `Present` and a concrete end date are not
automatically compatible unless the source date makes the interpretation
reliable under `FR-CD-06`.

Descriptions and other free text are never concatenated automatically. One
description containing the other may be shown as a suggested enrichment, but
the candidate still confirms the final text.

An absent field must eventually distinguish `never supplied` from
`intentionally cleared by candidate`. A candidate-cleared field is an
authoritative decision and extraction must not silently restore it.

## 7. Behavior by claim pair

### Pending + pending

When identity is strong and there are no unresolved fields, the service
auto-merges unedited extracted claims. It keeps the oldest claim, writes the
merged compatible values, combines source occurrences without duplicates, and
retires the other claim. The survivor becomes `auto_accepted`, is exported,
and carries a pending auto-merge notice until the candidate acknowledges it.
The notice stores the pre-merge claim values and physical source evidence so
the review drawer can name and preview every original source. Before
acknowledgment, the candidate may instead keep the claims separate; that
restores the snapshots atomically and records the unchanged pairs as
different so they are not immediately suggested again.

If identity is uncertain or any field conflicts, both claims remain unchanged
and the candidate receives a merge proposal with the conflicting fields. When
the candidate resolves every conflict and confirms the final values, the
survivor becomes `accepted` and is exported immediately.

### Accepted + pending

The accepted claim remains the exported profile value while the pending claim
is a staged proposal. When the pair is equivalent, has no unresolved fields,
and the pending claim was not candidate-edited, compatible optional values and
precision improvements are applied automatically. The accepted survivor becomes
`auto_accepted` and receives a merge notice; the candidate acknowledges it to
return the status to `accepted`. Other proposals still require confirmation.

On confirmation, the service updates the accepted survivor, archives its
previous values as a revision, attaches the accepted source occurrences, and
retires the pending duplicate in one transaction. Rejecting the proposal
leaves the accepted claim unchanged and marks the pending claim rejected.
Because the survivor was already accepted, the updated values appear in export
as soon as the transaction commits.

### Accepted + accepted

Both claims remain exported until the candidate explicitly confirms that they
are duplicates. The candidate chooses the survivor and final values. Applying
the decision updates the survivor and retires the other claim while preserving
history and provenance. The survivor remains accepted and the resolved values
replace the two previous exported records.

### Candidate-authoritative + extracted

Candidate-entered or candidate-edited populated fields win even when the
extracted claim is more detailed. Extraction may propose a value only for an
unset field that the candidate has not intentionally cleared. The extracted
source can be attached to any value the candidate accepts.

## 8. Merge proposal and resolution

A proposal is a read model, not a claim and not profile output. It contains:

- both claim IDs and versions;
- the proposed survivor;
- the proposed final values;
- each field's classification and authority;
- unresolved candidate choices;
- the source occurrences supporting each value; and
- whether confirmation will update an accepted claim.

The candidate can confirm the proposal, edit its final values, declare the
claims different, or reject the pending extracted claim. Confirmation is not
allowed while any required conflict choice is unresolved.

Candidate confirmation is both resolution and publication. If the survivor is
pending, confirmation changes it to `accepted`; if it is already accepted,
confirmation updates it while retaining that status. The UI action should make
this result explicit, for example **Resolve and add to profile**. Saving or
automatically generating a proposal does not publish anything.

### Selected-batch resolution

The candidate may select multiple ready proposals or non-conflicting pending
claims and approve them with one action. Safe proposals may be preselected for
convenience, but candidate action is still required. Proposals with unresolved
conflicts are not eligible and must not be preselected.

Atomicity is per claim, duplicate pair, or explicitly selected duplicate
group, not across the whole selected batch. Each action preserves its own
transaction and version checks. A group locks all of its claims, updates its
survivor once, transfers every duplicate's sources, and retires all duplicates
together. A conflict or stale version in one action does not prevent unrelated
selections from being accepted. The batch response reports `accepted`,
`conflict`, and `failed` results per item so the UI can export successful
resolutions immediately and refresh only unsuccessful ones.

Independent batch actions run with a maximum concurrency of five. The service
rejects overlapping claim IDs before starting any action and preserves request
order in the per-item response. A group must contain distinct active claims of
one type, include its survivor, and be connected by current pair proposals.

Declaring the claims different records that decision for the pair so unchanged
claims are not repeatedly suggested. A material value or normalization change
may cause detection to run again. Automatic merging after extraction never
merges a pair with a recorded decision, whatever the claims' versions, because
the candidate does not see it before it happens.

## 9. Persistence and audit direction

Implementation should preserve the current claim and revision tables and add
the smallest persistence needed for durable duplicate decisions. A duplicate
decision needs, at minimum:

- candidate ID and the ordered pair of claim IDs;
- status such as `pending`, `merged`, or `different`;
- versions observed when the proposal was made;
- survivor claim ID for a completed merge;
- final field choices or enough data to audit them; and
- created, updated, and resolved timestamps.

Retired claims must not appear in profile export or ordinary active-claim
lists, but must remain available for audit. A dedicated retirement or
supersession relationship is preferable to deleting accepted claims. Pending
claims that have never been exported may still be deleted only if their
provenance and merge decision remain recoverable through the survivor and
audit record.

Source occurrences are combined by physical identity. Identical occurrences
are stored once; distinct documents or anchors are retained. Extraction
metadata remains associated with the claim or historical record that produced
it rather than being rewritten as manual provenance.

## 10. Transaction and concurrency rules

Applying a merge must:

1. lock both claims in deterministic claim-ID order;
2. verify candidate ownership, claim type, active state, and both expected
   versions;
3. validate the final values with the existing claim schema;
4. write a revision when the survivor's values change;
5. update the survivor, set it to `accepted` when confirmation resolves a
   pending pair, and increment its version;
6. transfer or associate accepted source occurrences;
7. retire the duplicate and complete the duplicate decision; and
8. commit all changes together.

If either version changed, nothing is written and the response includes the
current claims so the candidate can review a fresh proposal. Transient database
errors follow the existing bounded retry policy; version conflicts are never
retried.

A selected batch invokes this transaction separately for each independent
claim or pair. It is not one database transaction spanning the whole batch.

## 11. MVP acceptance scenarios

| Scenario | Expected result |
| --- | --- |
| Two pending employment claims differ only by absent `endDate` | One pending survivor with the populated compatible value and all sources |
| Pending claims contain `2020` and `2020-03` | One pending survivor with `2020-03` |
| Pending claims contain `2020-03` and `2020-04` | Both remain; candidate must resolve the conflict |
| Candidate resolves a pending pair and confirms its final values | Survivor becomes accepted and is exported without a second approval step |
| Service automatically coalesces compatible pending claims | Survivor remains pending and is not exported |
| Accepted manual claim and pending extraction have the same values | Accepted claim survives; pending duplicate can be rejected without changing export |
| Accepted manual claim lacks an optional field found by extraction | Field is proposed but export does not change before confirmation |
| Candidate value conflicts with a more detailed extraction | Candidate value is preselected; extraction cannot overwrite it |
| Two accepted claims are suspected duplicates | Neither is retired without explicit confirmation |
| Either claim changes after proposal creation | Merge fails with `409 VERSION_CONFLICT` and writes nothing |
| One item in a selected batch has a version conflict | Unrelated items may succeed; the response identifies the item to refresh |
| Candidate declares the pair different | Both remain and the unchanged pair is not suggested again |

## 12. Deferred work

- review item + claim and review item + review item merging;
- multi-claim grouping and one-to-many comparisons;
- automatic semantic merging of free text;
- global alias or canonical-term changes;
- reuse of conflict decisions across materially changed claim pairs; and
- mandatory `If-Match` headers for every merge operation.
