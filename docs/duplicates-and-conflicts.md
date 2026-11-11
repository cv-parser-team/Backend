# Duplicate and conflict resolution (design)

> **Status: in progress.** Built on `Main` after the processing pipeline merge
> (`231a6d4`). Part 1 (processing jobs, G1–G5) is implemented; see
> [Document processing](modules/document-processing.md#concurrency-and-duplicates).
> G6–G10 are next. Decisions that need approval are in
> [section 11](#11-open-decisions).

## 1. Goal

> As a user, I want duplicate documents and conflicting processing requests to
> be detected and resolved consistently, so that documents are not processed
> multiple times and existing data is not unintentionally overwritten.

| Card item | Section |
| --- | --- |
| Duplicate documents are detected using a defined, deterministic identity rule | [4](#4-duplicate-documents) |
| Repeated processing requests do not create duplicate records or jobs | [5](#5-processing-jobs) |
| Conflicting updates are detected before data is overwritten | [5](#5-processing-jobs), [6](#6-document-status), [7](#7-candidate-edits) |
| The resolution strategy is documented and applied consistently | [3](#3-the-strategy) |
| Recoverable conflicts are retried safely without duplicating side effects | [8](#8-retries) |
| Unresolvable conflicts produce a clear error and sufficient diagnostic logging | [9](#9-errors-and-logging) |
| Concurrent requests result in a consistent final state | [10](#10-concurrency-scenarios) |

## 2. Current state

**Already in place**

| What | Where |
| --- | --- |
| Uploads deduplicated by SHA-256 per owner and purpose, enforced by a unique index; concurrent uploads create one row | `documents.service.ts`, `documents_owner_purpose_sha256_unique` |
| Jobs are claimed with a guarded `queued → processing` update and a 5-minute lease | `claimJob` |
| Document transitions used by the worker are guarded: `ready` and `failed` only from `processing` | `markDocumentReady`, `markDocumentFailed` |
| Retries with a delay, a limit of 3 attempts, lease recovery, dead-lettering, and republishing of queued jobs | `document-processing.service.ts`, `workers/` |
| Deleting a document deletes its jobs (`on delete cascade`) | `document-processing.table.ts` |

**Gaps**

| # | Gap | Where | Effect | Status |
| --- | --- | --- | --- | --- |
| G1 | `completeJob`, `retryJob`, and `failJob` check only `status = 'processing'` | `document-processing.repository.ts` | After a lease expires and another worker claims the job, the old worker can complete, retry, or fail the new attempt | Done |
| G2 | The parsing result is saved without checking that the attempt still owns the job | `parse-document.handler.ts` → `parsing.repository.ts` | An old attempt overwrites the result of the newer one | Done |
| G3 | Nothing stops two active jobs for one document | `createQueuedJob` | Duplicate processing of one document | Done |
| G4 | When the document is `deleting` or gone, the handler throws before its retry logic | `parse-document.handler.ts` | The message is requeued and skipped, the lease expires, the job is released, and it fails again: **the job loops forever**, and the 3-attempt limit never applies | Done |
| G5 | If `schedule` fails after the document is created, the file is reported as failed; the client re-uploads it, the upload is deduplicated, and nothing schedules it again | `documents.routes.ts` | The document stays `stored` with no job | Done |
| G6 | A deduplicated upload returns the existing document whatever its status | `uploadDocument` | Re-uploading a file that is being deleted returns a document that disappears a moment later | Next |
| G7 | Claim edits read and then write without a lock or version | `updateClaimValues` | Two simultaneous edits: one is lost, and both revisions archive the same old values | Next |
| G8 | Profile updates have no version | `updateCandidate` | The later save silently overwrites the earlier one | Next |
| G9 | Creating a profile twice at once returns `UNIQUE_CONSTRAINT_VIOLATION` instead of `CANDIDATE_PROFILE_EXISTS` | `createProfile` | Two different errors for one situation | Next |
| G10 | Deadlocks and serialization failures are reported as a generic `DATABASE_ERROR` | `database.errors.ts` | Retryable and permanent failures cannot be told apart | Next |

While building part 1, two more cases were found and fixed: a worker that keeps
crashing never reached the retry limit (now failed with
`MAX_ATTEMPTS_EXCEEDED`), and a crash between completing the job and marking
the document ready left the document `processing` forever (now one
transaction).

## 3. The strategy

Every write follows one of five rules. New code picks the rule that fits.

| Rule | Use when | How |
| --- | --- | --- |
| **R1. Insert or get** | Creating something with an identity | Unique index, `ON CONFLICT DO NOTHING`, then read the existing row. The database decides. |
| **R2. Guarded transition** | Changing a status | `UPDATE … WHERE status IN (allowed sources)`. Zero rows: someone else acted first. |
| **R3. Fencing** | A worker writes results or finishes a job | The `attempt_count` returned by `claimJob` is the token. Every write checks `status = 'processing' AND attempt_count = token`. |
| **R4. Optimistic version** | A person edits data they have seen | `version` column; the client sends the version it saw; `UPDATE … WHERE version = seen`. |
| **R5. Bounded retry** | A failure that may pass | Retry only errors marked retryable, a limited number of times, and only steps protected by R1–R4. |

**Who wins**

| Conflict | Winner | Loser |
| --- | --- | --- |
| Same document uploaded twice | First stored row | Gets the existing document, `deduplicated: true` |
| Same document scheduled twice | The active job | Gets the active job; no new job |
| Delete during processing | **Delete** | The worker stops; job `failed` with `document_deleted` |
| Two attempts of one job | The newest attempt | Old attempt's writes are refused; it stops |
| Two edits of one claim or profile | The first save | `409 VERSION_CONFLICT` with the current data |

## 4. Duplicate documents

**Identity rule:** `(owner_user_id, purpose, sha256)`, already enforced by a
unique index. The filename does not matter; a different purpose or different
bytes is a different document.

**Change (G5, G6):** the upload result depends on the existing document:

| Existing document | Result |
| --- | --- |
| `processing` or `ready` | Existing document, `deduplicated: true` |
| `stored` or `failed` with no active job | Existing document, `deduplicated: true`, and a job is scheduled (R1, so this is safe if one already exists) |
| `deleting` | `409 DOCUMENT_BEING_DELETED` |

`markDocumentProcessing` then also accepts `failed`, so a failed document can
be processed again.

## 5. Processing jobs

**One active job per document (G3)**, in `document-processing.table.ts`:

```ts
uniqueIndex('document_processing_jobs_active_document_unique')
  .on(table.documentId)
  .where(sql`${table.status} in ('queued', 'processing', 'retrying')`)
```

`createQueuedJob` uses `onConflictDoNothing()` and returns the existing active
job (R1). `schedule` then publishes that job; a duplicate message is harmless
because claiming is guarded.

**Fencing (G1, G2).** The handler keeps `processingJob.attemptCount` from
`claim` and passes it to every later write:

| Write | Condition added |
| --- | --- |
| `completeJob`, `retryJob`, `failJob` | `attempt_count = token` |
| Saving the parsing result | Saved in one transaction with a check that the job is still `processing` with this token; otherwise nothing is written |

A `null` result means "this attempt no longer owns the job": the handler logs
it and acknowledges the message without writing anything else.

**Deleted documents (G4).** The handler checks the document before and after
parsing:

| Situation | Action |
| --- | --- |
| Document missing or `deleting` | `failJob(token, 'document_deleted')`, acknowledge; no retry |
| `markDocumentReady` returns `null` because of a delete | Same |

So the job ends once, instead of looping through lease expiry.

**Attempt limit.** The limit is checked right after claiming, not only after a
parsing error: a job claimed with `attemptCount > 3` (repeated worker crashes)
is failed with `max_attempts_exceeded`.

## 6. Document status

| Transition | Allowed from | Guard fails |
| --- | --- | --- |
| Start processing | `stored`, `processing` (lease recovery), `failed` (re-processing) | Document deleted: see section 5 |
| Ready, failed | `processing` | Stop; see section 5 |
| Delete | any status except `deleting` | Already `deleting`: `204`, delete is idempotent |

The delete path keeps its unconditional `updateDocumentStatus` call, which is
renamed `markDocumentDeleting` and is the only remaining unguarded change.

## 7. Candidate edits

**G7, G8:** `claims` and `candidates` get a `version` integer column (starts at
1, increases on every change), returned in every response.

- `PUT /me/claims/:claimId`, `DELETE /me/claims/:claimId`, and `PATCH /me`
  accept the version in the `If-Match` header.
- The update runs `WHERE version = seen` (R4). The claim revision is written in
  the same transaction, only when the update succeeds.
- Mismatch: `409 VERSION_CONFLICT` with the current record in `details`.

A version is used instead of `updated_at` because PostgreSQL keeps
microseconds and JavaScript dates only milliseconds.

**G9:** `createProfile` maps the unique violation to
`CandidateProfileExistsError`.

## 8. Retries

**G10:** `mapDatabaseError` gains `TransientDatabaseError` (`503`,
`retryable`) for `40001` (serialization), `40P01` (deadlock), and `55P03`
(lock not available).

| Place | Policy |
| --- | --- |
| HTTP requests | A transaction failing with a transient error is retried up to 3 times with a short random delay (`withTransientRetry`) |
| Worker | Existing `retrying` flow with its delay and 3-attempt limit |
| Guard failures (R2–R4) | **Never retried**: someone else already acted |

Why retries cannot duplicate side effects:

| Side effect | Protected by |
| --- | --- |
| Document row and file | R1 on owner + purpose + SHA-256; orphan cleanup |
| Job | R1 on one active job per document |
| Parsing result | One row per document, R3 |
| Status change | R2 |
| Claim edit and revision | R4, one transaction |

## 9. Errors and logging

| Code | Status | When |
| --- | --- | --- |
| `VERSION_CONFLICT` | 409 | Record changed since the client read it |
| `DOCUMENT_BEING_DELETED` | 409 | Upload of a document in `deleting` |
| `TRANSIENT_DATABASE_ERROR` | 503 | Transient retries used up |

Worker outcomes gain `stale` (attempt no longer owns the job) and
`document_deleted`, logged with `jobId`, `documentId`, `attempt`, `expected`,
and `actual`. Logs never include file contents, parsed text, or claim values.

## 10. Concurrency scenarios

Each row becomes a test.

| # | Scenario | Final state |
| --- | --- | --- |
| C1 | Same file uploaded in two requests at once | One document, one job |
| C2 | `schedule` called twice for one document | One active job |
| C3 | Job message delivered twice | One processing run |
| C4 | Worker crashes; lease expires; another worker claims | One result, from the newest attempt |
| C5 | Old attempt finishes after a newer claim | Its result and status writes are refused |
| C6 | Document deleted while queued or processing | Document gone; job `failed` with `document_deleted`; no loop |
| C7 | `schedule` fails after upload; file uploaded again | One job is scheduled |
| C8 | Re-upload while the document is being deleted | `409 DOCUMENT_BEING_DELETED` |
| C9 | Two edits of one claim with the same version | One succeeds, one `409`; one revision |
| C10 | Two profile updates with the same version | Same as C9 |
| C11 | Two profile creations at once | One profile; the other `409 CANDIDATE_PROFILE_EXISTS` |
| C12 | Deadlock during a claim edit | Retried; one consistent result |

Unit and service tests use doubles. C1, C2, C4–C6, and C9–C11 also need tests
against a real PostgreSQL test database (none exist yet), skipped when no test
database URL is set.

## 11. Open decisions

| # | Question | Proposal |
| --- | --- | --- |
| 1 | `version` column on `claims` and `candidates` | Yes |
| 2 | Is `If-Match` required? | Optional now, required once the frontend sends it |
| 3 | Re-upload of a failed document starts a new job | Yes |
| 4 | Add database integration tests | Yes, with a separate test database |

## 12. Implementation order

1. **Jobs (G1–G5):** active-job index and migration, fencing, deleted
   documents, attempt limit, scheduling on deduplicated uploads.
2. **Errors and retry (G10):** `TransientDatabaseError`,
   `withTransientRetry`.
3. **Documents (G6):** `409` while deleting, idempotent delete.
4. **Candidate edits (G7–G9):** `version` columns and migration, `If-Match`.
5. **Integration tests** for the scenarios above.
6. **Docs:** `document-processing.md`, `documents.md`, `candidates.md`,
   README, and a link from `architecture.md` to this strategy.
