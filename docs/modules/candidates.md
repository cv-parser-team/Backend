# Candidates module

The `candidates` module lets a candidate manage their profile and claims, and
exports a structured JSON profile. See the [README](../../README.md) for the
endpoints and the [Data model](../database/data-model.md) for the tables.

## Key decisions

1. **One profile per user, always `/me`.** The user comes from the access
   token, never from the URL. Another candidate's claims return 404.
2. **Every piece of profile information is a claim** with a type, an origin
   (`manual` or `extracted`), and a status (`pending`, `accepted`, or
   `rejected`). Manual claims are accepted immediately.
3. **The export contains accepted claims only.**
4. **One details table per claim type.** Real columns let profile search query
   claims directly, such as finding candidates with a given skill.
5. **Edits archive the previous values** in `claim_revisions`, so the original
   values are never lost.
6. **Ready for document parsing.** The `extracted` origin exists, and exported
   claims include an empty `sources` list for document references.
7. **Six claim types:** skills, employment, education, certifications,
   languages, and projects. Languages keep their proficiency as written, such
   as "Native" or "C1"; one scale is left to normalization. Project dates are
   optional, because many CVs list projects without them.
8. **Two emails.** `email` is the account email from the users module.
   `contactEmail` is the optional email shown on the CV and profile, which can
   differ from it. Both appear in the exported profile.
9. **Nothing from a CV is lost.** Courses, awards, and other information
   outside these claim types are kept in `document_extractions.unmapped_data`
   by the AI-output mapping, not as claims.
10. **Claims are normalized after they are saved.** Skill names, job titles,
    and degrees are linked to canonical terms by the normalization module,
    without changing the claim. If normalization fails, the claim is still
    saved. See [Normalization](normalization.md).

## Editing a claim

```mermaid
sequenceDiagram
    actor Candidate
    participant Service
    participant Repository
    participant Database

    Candidate->>Service: PUT /api/candidates/me/claims/:claimId
    Service->>Repository: findClaim(candidateId, claimId)
    alt Claim not found or owned by another candidate
        Service-->>Candidate: 404
    else Claim type changed
        Service-->>Candidate: 400
    else Values unchanged
        Service-->>Candidate: 200, nothing written
    else Values changed
        Service->>Repository: updateClaimValues(values)
        Note over Repository,Database: One transaction
        Repository->>Database: Save current values in claim_revisions
        Repository->>Database: Update the type's details table
        Repository-->>Candidate: 200 with the new values
    end
```

## Claim status and export

```mermaid
stateDiagram-v2
    [*] --> accepted: Candidate adds the claim
    [*] --> pending: Extracted from a document
    pending --> accepted: Candidate accepts
    pending --> rejected: Candidate rejects
    accepted --> Exported: GET /api/candidates/me/profile
    note right of Exported
        Only accepted claims appear
        in the exported JSON profile.
    end note
```

Extraction and review belong to the document parsing feature; this module
already stores and filters their statuses.
