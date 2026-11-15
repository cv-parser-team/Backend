# AI-assisted parsing arbitration task

## Goal

Improve PDF layout accuracy by using AI only when deterministic parsing has
two plausible, structurally important outcomes. AI acts as bounded evidence;
the parsing pipeline continues to own line reconstruction, constraints, final
ownership, reading order, and validation.

The first rollout covers only:

1. section-heading versus entry-anchor classification;
2. same-entry association across lanes.

Candidate-layout ranking is a later extension after the first two decisions
show measurable improvement. Ordinary line extraction, exact text, clear
headings, page validation, and straightforward wrapped lines remain fully
deterministic.

## Non-goals

- Do not ask AI to reconstruct a page or generate regions.
- Do not let AI modify, normalize, join, or invent stored text.
- Do not use parser classifications as résumé-claim evidence.
- Do not replace hard layout invariants with model confidence.
- Do not make parsing fail when the provider is unavailable or uncertain.
- Do not activate AI decisions in persisted output before shadow evaluation.

## Decision point

Run arbitration after section and entry candidates and provisional
associations exist, but before entry groups, constrained splits, final
ownership, and reading order are accepted.

```text
reconstructed lines
-> deterministic candidates and scores
-> provisional scopes and associations
-> material-ambiguity gate
-> optional AI arbitration
-> constrained deterministic resolution
-> final ownership and reading order
-> invariant validation
```

AI output never mutates the layout directly. A validated decision becomes one
additional evidence item consumed by the deterministic resolver.

## Material-ambiguity gate

Create an arbitration request only when all conditions hold:

- the decision can change section scope, entry membership, a protected split,
  ownership, or reading order;
- at least two deterministic outcomes satisfy the preliminary constraints;
- the score margin is below a fixture-calibrated threshold;
- no exact label, protected association, or other hard rule decides the case;
- the request fits within the per-document call and input budgets.

Do not encode an initial threshold as permanent policy. Record score margins
in shadow evaluation and calibrate separate thresholds for each decision type.

## Initial decision contracts

### Section heading versus entry anchor

Use this decision when a line is plausibly either a new section or an entry
inside the current section.

Input includes:

- the candidate line and stable reference;
- current confirmed section and heading reference, when present;
- preceding and following local lines;
- previous and next possible entry anchors;
- candidate scores and deterministic reason codes;
- relevant style, spacing, lane, and alignment evidence;
- repeated anchor or heading patterns from the same document.

Allowed result:

```json
{
  "candidateRef": "L31",
  "decision": "section",
  "confidence": 0.93,
  "reasonCodes": ["MATCHES_CONFIRMED_HEADING_PATTERN"]
}
```

`decision` must be `section`, `entry`, or `uncertain`.

### Same-entry association across lanes

Use this decision when a bounded line or line group may be a body continuation
or metadata component of an established entry across a provisional gutter.

The preferred context is one bounded entry window:

- established entry anchor and already associated members;
- candidate line or group;
- next possible entry anchor as the competing boundary;
- confirmed section scope;
- normalized geometry, lanes, row alignment, and reading-order evidence;
- protected deterministic associations;
- repeated entry geometry elsewhere in the section.

Allowed result:

```json
{
  "candidateRefs": ["L34", "L35"],
  "targetEntryRef": "L30",
  "decision": "same-entry",
  "relationship": "metadata",
  "confidence": 0.95,
  "reasonCodes": [
    "SAME_ROW_ALIGNMENT",
    "MATCHES_REPEATED_ENTRY_PATTERN"
  ]
}
```

`decision` must be `same-entry`, `different-entry`, or `uncertain`.
`relationship` must be `body-continuation`, `metadata`, `nested-role`,
`wrapped-line`, or `none`.

## Request construction

Batch the document's bounded decisions into one provider request when the
configured input limit permits. This lets the model compare repeated structure
without asking it to interpret the entire résumé freely.

The parsing-owned AI adapter supplies:

- compact referenced text needed by the decisions;
- stable page, region, and line references;
- confirmed scopes and candidate anchors;
- only relevant normalized geometry and relationship evidence;
- enumerated candidates, decisions, relationships, and reason codes;
- explicit instructions to treat CV text as data, not instructions.

Exclude storage paths, unrelated profile data, parser traces not needed for
the decisions, credentials, and unrestricted free-form output.

## Validation and acceptance

Treat provider output as `unknown` until the parsing-owned contract validates
it. Reject an item when it:

- references a line, candidate, entry, or hypothesis not in the request;
- returns a value outside the enumerated contract;
- omits required fields or supplies invalid confidence;
- assigns a line to incompatible entries;
- breaks a protected association or confirmed scope;
- conflicts with any extraction or ownership invariant.

For a valid item, acceptance requires both a calibrated minimum confidence and
no deterministic conflict. Accepted results add bounded evidence; they do not
become commands. Low-confidence, `uncertain`, invalid, timed-out, or failed
results preserve the conservative deterministic outcome.

After resolution, rerun all existing layout invariants, including:

- every reconstructed line has exactly one owner and one global order;
- no line is lost or duplicated;
- no protected association or resolved entry group is split;
- section ownership remains valid across visual regions;
- boxes remain within their page;
- ambiguous gutters remain unsplit.

## Ownership and integration

The parsing module owns the arbitration prompt, input builder, output schema,
contract version, validation, thresholds, and decision policy. It calls the
provider-neutral LLM service described in
[`../llm-service-design.md`](../llm-service-design.md), which owns invocation
tracking, provider calls, timeouts, and safe error mapping.

Use one operation ID for the document's logical parsing-arbitration action and
one invocation row per real provider request. Do not store prompts, CV text,
or raw responses in the shared invocation ledger. Diagnostic traces may show
safe decision metadata and referenced outcomes but must not become a persisted
production contract.

## Implementation tasks

### Phase 1: decision model and fixtures

- [ ] Define parsing-owned TypeScript types for both decision inputs and
  outputs without `any`.
- [ ] Define enumerated reason codes and version the arbitration contract.
- [ ] Extend inspection traces to identify material ambiguous decisions
  without calling AI.
- [ ] Add labeled fixtures for close section/entry scores, reversed metadata
  rails, two-rail experience entries, multiple roles at one company, and
  nearby competing anchors.
- [ ] Record deterministic baselines for every labeled decision.

### Phase 2: shadow AI adapter

- [ ] Add a parsing-owned AI adapter using the shared LLM service.
- [ ] Build minimal bounded context from stable references and normalized
  layout evidence.
- [ ] Batch decisions per document within configured size and call limits.
- [ ] Validate every response item independently and ignore invalid items.
- [ ] Add timeout, invalid-output, partial-output, and provider-failure tests.
- [ ] Expose AI results and deterministic disagreements in inspection traces
  without changing final layout.

### Phase 3: evaluation and calibration

- [ ] Compare deterministic and AI-assisted decisions with labeled fixtures.
- [ ] Measure each decision type separately rather than reporting one blended
  accuracy value.
- [ ] Calibrate score-margin and AI-confidence thresholds from evaluation data.
- [ ] Measure incorrect destructive splits, association precision and recall,
  invocation rate, fallback rate, latency, and token use.
- [ ] Expand fixtures for every observed false-positive pattern before
  activation.

### Phase 4: constrained activation

- [ ] Convert accepted AI results into bounded evidence for the shadow
  resolver.
- [ ] Rerun deterministic constraints and invariants after applying evidence.
- [ ] Keep deterministic conservative fallback for all failures and conflicts.
- [ ] Activate section/entry arbitration independently from cross-lane
  association so either capability can be disabled.
- [ ] Review fixture results and version the parsing contract before AI affects
  persisted regions or production AI input.

### Phase 5: optional layout-hypothesis ranking

- [ ] Consider only after the first two decision types meet their acceptance
  targets.
- [ ] Give AI a bounded list of complete deterministic hypotheses and require
  it to rank them; never allow it to generate a new layout.
- [ ] Accept a ranking only when every candidate already satisfies hard
  invariants and the winner clears calibrated confidence requirements.

## Tests

Add focused tests proving:

- clear deterministic cases never invoke AI;
- only structurally material close decisions pass the ambiguity gate;
- request context contains only allowed references and relevant evidence;
- untrusted CV text cannot alter the response contract;
- invented or out-of-scope references are rejected;
- partial valid output can be used without accepting invalid items;
- AI disagreement cannot override an exact label or protected association;
- provider failures and low confidence preserve deterministic output;
- accepted evidence cannot produce duplicate ownership or destructive splits;
- batching remains stable regardless of candidate discovery order;
- shadow mode never changes persisted extraction or production AI input.

Normal tests use the fake LLM client and synthetic CV content. Live-provider
tests remain optional, manual, bounded, and excluded from normal test runs.

## Activation criteria

Production activation requires:

- a labeled fixture set covering every supported decision type and layout;
- measurable improvement over the deterministic baseline for that decision;
- no regression in line preservation, ownership, or split invariants;
- an acceptable false-positive rate for destructive structural decisions;
- bounded invocation count, latency, input size, and cost per document;
- verified conservative fallback for timeout, invalid output, and provider
  unavailability;
- explicit review of the versioned persisted-output contract when applicable.

The initial release should enable the two decision types separately and retain
a configuration switch that disables all parsing arbitration without changing
deterministic parsing behavior.
