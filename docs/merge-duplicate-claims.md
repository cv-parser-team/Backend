# Merge duplicate claims and resolve related conflicts

> **Status: MVP design; not implemented.** This document narrows the first
> delivery to claim-to-claim comparison and merge. Extraction review items are
> deliberately out of scope.

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

The MVP does not merge extraction review items, compare more than two claims
in one operation, infer a claim type, or change the global normalization
dictionary. A review item continues through its existing resolve or dismiss
flow; once resolution creates a claim, a later claim-to-claim comparison may
include it.

## 3. Invariants

1. **Extraction is staged.** A claim created by document extraction starts as
   `pending` and is excluded from profile export. Duplicate handling must not
   make extracted information visible without candidate confirmation.
2. **Candidate decisions have precedence.** Candidate-entered and
   candidate-edited values are authoritative over extracted values.
3. **Completeness is only a tie-breaker.** A populated optional field or a
   more precise date wins automatically only when the values are compatible
   and have equal authority.
4. **Conflicts are not guessed away.** Incompatible populated values require
   the candidate to select or enter the final value.
5. **Provenance survives.** A merge retains the original claims, revisions,
   extraction metadata, and physical source occurrences needed for audit.
6. **One confirmation, one atomic result.** Applying a merge and retiring its
   duplicate claims succeeds or fails in one transaction.
7. **Concurrent edits are refused.** The merge is conditional on the versions
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
| Pending + pending | Oldest claim is the stable survivor and remains `pending` |
| Accepted + pending | Accepted claim survives; it is not changed until confirmation |
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

When identity is strong and there are no conflicting fields, the service may
coalesce the claims automatically. It keeps the oldest claim, writes the
merged compatible values, combines source occurrences without duplicates,
and retires the other claim. The survivor remains `pending`, so it is still not
exported.

If identity is uncertain or any field conflicts, both claims remain unchanged
and the candidate receives a merge proposal with the conflicting fields.

### Accepted + pending

The accepted claim remains the exported profile value while the pending claim
is a staged proposal. Compatible optional values and precision improvements
may be preselected in the proposal, but they are not written to the accepted
claim until the candidate confirms.

On confirmation, the service updates the accepted survivor, archives its
previous values as a revision, attaches the accepted source occurrences, and
retires the pending duplicate in one transaction. Rejecting the proposal
leaves the accepted claim unchanged and marks the pending claim rejected.

### Accepted + accepted

Both claims remain exported until the candidate explicitly confirms that they
are duplicates. The candidate chooses the survivor and final values. Applying
the decision updates the survivor and retires the other claim while preserving
history and provenance.

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

Declaring the claims different records that decision for the pair so unchanged
claims are not repeatedly suggested. A material value or normalization change
may cause detection to run again.

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
5. update the survivor and increment its version;
6. transfer or associate accepted source occurrences;
7. retire the duplicate and complete the duplicate decision; and
8. commit all changes together.

If either version changed, nothing is written and the response includes the
current claims so the candidate can review a fresh proposal. Transient database
errors follow the existing bounded retry policy; version conflicts are never
retried.

## 11. MVP acceptance scenarios

| Scenario | Expected result |
| --- | --- |
| Two pending employment claims differ only by absent `endDate` | One pending survivor with the populated compatible value and all sources |
| Pending claims contain `2020` and `2020-03` | One pending survivor with `2020-03` |
| Pending claims contain `2020-03` and `2020-04` | Both remain; candidate must resolve the conflict |
| Accepted manual claim and pending extraction have the same values | Accepted claim survives; pending duplicate can be rejected without changing export |
| Accepted manual claim lacks an optional field found by extraction | Field is proposed but export does not change before confirmation |
| Candidate value conflicts with a more detailed extraction | Candidate value is preselected; extraction cannot overwrite it |
| Two accepted claims are suspected duplicates | Neither is retired without explicit confirmation |
| Either claim changes after proposal creation | Merge fails with `409 VERSION_CONFLICT` and writes nothing |
| Candidate declares the pair different | Both remain and the unchanged pair is not suggested again |

## 12. Deferred work

- review item + claim and review item + review item merging;
- multi-claim grouping and one-to-many comparisons;
- automatic semantic merging of free text;
- global alias or canonical-term changes;
- reuse of conflict decisions across materially changed claim pairs; and
- mandatory `If-Match` headers for every merge operation.
