Auto-accept duplicates + claim-card merge warning

Confidence (locked)

No new numeric merge score. **High enough** = existing merge rules for a safe auto-merge:

* identity `equivalent` (not `suspected_duplicate`)
  
* no unresolved fields (`conflict` / `warning` / `compatible`)
  
* survivor selectable without candidate choice
  
* neither side candidate-edited when the edited side would lose authority incorrectly
  

Same bar as today’s `automatic_coalesce`, **extended** to accepted+pending safe enrichments. Extraction’s `≥ 0.95` stays create-time only.Storage decision (replaces `merge_messages` on claims)

**Do not** put messages on `claims` as jsonb. **Do not** reuse `extraction_review_items`:

* owned by extraction, tied to one `document_id` / invocation
  
* requires nonempty `issues` (check constraint)
  
* re-extraction deletes pending rows
  
* purpose is “could not become a claim,” not “claim was auto-merged”
  

**Use instead:**

1. New claim status: **`auto_accepted`**
  
  * Meaning: published like `accepted`, but produced/updated by auto-merge and still awaiting user acknowledgment.
    
  * Profile export and “accepted” list filters treat it like `accepted`.
    
  * On acknowledge → flip to `accepted`.
    
2. New candidates-owned table: **`claim_auto_merge_notices`**
  
  * One row per auto-merge event on the survivor.
    
  * Holds human-readable messages, duplicate claim ids, and ack lifecycle.
    

Suggested names rejected for clarity: `acceptedAwaitingUser` (too vague about _what_ is awaiting), `provisionally_accepted` (sounds unpublished). **`auto_accepted`** states both publication and system origin.Behavior (locked — scope 2)

|     |     |
| --- | --- |
| Pair | High-confidence action |
| Pending + pending (extracted, unedited) | Coalesce into survivor, set `auto_accepted`, insert notice |
| Accepted / auto_accepted + pending (safe enrichments only) | Write into survivor, supersede pending, set survivor `auto_accepted`, insert notice |
| Anything with conflicts / suspected identity | Unchanged — Issues + CoalescenceModal |

Update `[docs/merge-duplicate-claims.md](docs/merge-duplicate-claims.md)`: high-confidence auto-merge publishes as `auto_accepted`; uncertain work stays staged. flowchart TD extract[Extraction writes claims] --> scan[Scan same-type active pairs] scan --> conf{equivalent and no unresolved fields?} conf -->|no| issues[Stay in merge-candidates / Issues UI] conf -->|yes pending+pending| coalesceAccept["Coalesce + status auto_accepted"] conf -->|yes accepted+pending| enrichAccept["Merge into survivor + auto_accepted"] coalesceAccept --> notice[Insert claim_auto_merge_notices] enrichAccept --> notice notice --> profile[GET claims + open notices] profile --> card[Profile Row warning] card --> ack[User acknowledges] ack --> accepted[status accepted + notice acknowledged]Schema sketch

**`claim_status` enum:** `pending` | `accepted` | `auto_accepted` | `rejected`

**`claim_auto_merge_notices`** (candidates module, next to claims):

* `notice_id` UUID PK
  
* `candidate_id` UUID FK
  
* `survivor_claim_id` UUID FK → claims
  
* `superseded_claim_ids` UUID[] (or jsonb)
  
* `messages` text[] / jsonb string[] — short copy from field classifications
  
* `status` `pending` | `acknowledged`
  
* `created_at` / `updated_at` / optional `acknowledged_at`
  
* index on `(survivor_claim_id, status)` and `candidate_id`
  

Backend small steps

### B1 — Status + notices table

* Extend `[claimStatus](luminaCV/src/modules/candidates/candidates.table.ts)` with `auto_accepted`.
  
* Add `claim_auto_merge_notices` table + migration; re-export via schema.
  
* Extend `ClaimRecord` / list responses; either embed `openMergeNotices` on claims or add `GET .../claims/auto-merge-notices?status=pending` (prefer embed on claim list/get used by profile to avoid an extra FE round-trip).
  

### B2 — Message builder

* Pure helper in `[candidates.claim-comparison.ts](luminaCV/src/modules/candidates/candidates.claim-comparison.ts)` from proposal `fields` → short strings (“Combined sources”, “Added description”, “More precise start date”).
  
* Unit tests.
  

### B3 — Widen eligibility

* `canAutoAcceptMerge`: pending+pending (today’s coalesce gate) + accepted/auto_accepted+pending when equivalent, no unresolved fields, survivor is the accepted side, pending not candidate-edited.
  
* Plan builders for both paths.
  

### B4 — Repository writes

* Pending+pending coalesce → survivor `auto_accepted` + insert notice.
  
* Accepted+pending → confirmed-merge write path + survivor `auto_accepted` + insert notice.
  
* Multiple auto-merges on same survivor append separate notice rows (or one pending notice with appended messages — prefer **separate rows** for audit clarity).
  

### B5 — Post-extraction runner

* `autoAcceptHighConfidenceDuplicates(candidateId)` after successful extraction save.
  
* Skip overlapping IDs / version conflicts; leave those for Issues UI.
  

### B6 — Acknowledge API

* e.g. `POST /api/candidates/me/claims/:claimId/acknowledge-auto-merge` (or per `noticeId`).
  
* Marks open notices for that claim `acknowledged`; if claim is `auto_accepted` and no remaining pending notices, set status `accepted`.
  
* Version / ownership checks + tests.
  

### B7 — Export parity

* `[exportProfile](luminaCV/src/modules/candidates/candidates.service.ts)` / list filters that today use `status = accepted` also include `auto_accepted`.
  
* Review/accept paths: candidate explicit accept of a normal pending claim still → `accepted` (not `auto_accepted`).
  

### B8 — Docs + tests

* Update merge doc, data-model, candidates module docs, README if needed.
  
* Comparison / repository / service / export tests; `npm run build` + relevant tests.
  

Frontend small steps

### F1 — Map status + notices

* `[useProfileData.js](Frontend/src/hooks/useProfileData.js)`: treat `auto_accepted` like accepted for collection placement; keep `mergeNotices` / messages on the mapped item.

### F2 — Claim-card warning

* `[Row.jsx](Frontend/src/components/profile/sections/Row.jsx)` warning slot (amber callout / existing badge language).
  
* Wire in CollectionSection / rowMappers when open notices exist; SkillChip if skills can carry notices.
  

### F3 — Acknowledge UI

* API helper in `[candidateApi.js](Frontend/src/api/candidateApi.js)`; dismiss/acknowledge clears warning and refreshes claim status locally.

### F4 — Issues refresh

* After extraction reload, auto-merged pairs drop from merge-candidates; no extra FE merge logic.

Out of scope

* Suspected duplicates / conflicts (manual CoalescenceModal).
  
* Persisting extraction confidence on claims.
  
* Accepted+accepted auto-merge.
  
* Extending `extraction_review_items` for merges.