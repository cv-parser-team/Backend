# Proposed domain ERD

based on the functional requirements and does not represent the currently implemented database.

Attribute types are proposed PostgreSQL-oriented domain types. They become
authoritative only when implemented in the owning module's Drizzle tables.

See [Data model](data-model.md) for the implemented schema.

```mermaid
erDiagram
    User {
        uuid user_id PK
        text name
        text email UK
        text password_hash
        user_role role
        account_status account_status
        timestamptz email_verified_at
        timestamptz created_at
    }
    AuthTokenVersion {
        uuid user_id PK, FK
        integer version
        timestamptz updated_at
    }
    AuditLog {
        uuid audit_id PK
        uuid user_id FK "nullable"
        actor_type actor_type
        text action
        text entity_type
        uuid entity_id
        jsonb previous_value
        jsonb new_value
        text reason
        timestamptz created_at
    }
    Candidate {
        uuid candidate_id PK
        uuid user_id FK, UK
        text full_name
        text phone
        text location
        jsonb profile_links
        timestamptz created_at
        timestamptz updated_at
    }
    SourceDocument {
        uuid document_id PK
        uuid candidate_id FK
        source_type source_type
        text original_filename
        text file_format
        bigint file_size
        integer version_no
        text storage_ref
        text file_hash
        timestamptz uploaded_at
        processing_status processing_status
        integer attempt_count
        text error_details
        jsonb parsed_content
        jsonb failed_portions
        jsonb unmapped_data
    }
    EvidenceDocument {
        uuid evidence_id PK
        uuid candidate_id FK
        text file_name
        text file_type
        bigint file_size
        text storage_ref
        timestamptz uploaded_at
        text certificate_title
        text issuer
        date issue_date
        date expiry_date
        text credential_id
        verification_status verification_status
    }
    Claim {
        uuid claim_id PK
        uuid candidate_id FK
        claim_type claim_type
        claim_origin origin
        claim_status status
        numeric confidence_score
        uuid matched_claim_id FK "references Claim"
        match_status match_status
        timestamptz created_at
        timestamptz updated_at
    }
    SourceOccurrence {
        uuid occurrence_id PK
        uuid claim_id FK
        uuid document_id FK
        integer page_number
        jsonb position
        text section
        text text_span
    }
    ClaimValueHistory {
        uuid value_id PK
        uuid claim_id FK
        text field_name
        jsonb value
        claim_value_status value_status
        validation_status validation_status
        timestamptz created_at
    }
    NormalizationDecision {
        uuid normalization_id PK
        uuid claim_id FK
        uuid term_id FK "nullable"
        normalization_method method
        numeric confidence_score
        actor_type actor_type
        text rule_version
        normalization_status status
        timestamptz created_at
    }
    Conflict {
        uuid conflict_id PK
        uuid claim_id FK
        text field_name
        conflict_type conflict_type
        conflict_status status
        jsonb selected_value
        text resolution_reason
        timestamptz created_at
        timestamptz resolved_at
    }
    ClaimEvidence {
        uuid claim_id PK, FK
        uuid evidence_id PK, FK
        attachment_status attachment_status
        timestamptz attached_at
    }
    Alias {
        uuid alias_id PK
        uuid term_id FK
        text alias_text
        alias_scope scope
        uuid candidate_id FK "nullable"
        alias_origin origin
        alias_status status
        timestamptz created_at
    }
    CanonicalTerm {
        uuid term_id PK
        canonical_category category
        text canonical_name
        canonical_status status
        uuid merged_into_id FK "references CanonicalTerm"
        timestamptz created_at
    }
    ConflictValue {
        uuid conflict_value_id PK
        uuid conflict_id FK
        uuid occurrence_id FK
        jsonb value
        conflict_value_status status
    }
    AliasReview {
        uuid alias_review_id PK
        uuid alias_id FK
        review_status status
        uuid claimed_by FK "references User"
        timestamptz claimed_at
        timestamptz created_at
        timestamptz completed_at
        review_outcome outcome
        text reason
        timestamptz decided_at
    }
    CertificateReview {
        uuid certificate_review_id PK
        uuid evidence_id FK
        review_status status
        uuid claimed_by FK "references User"
        timestamptz claimed_at
        timestamptz created_at
        timestamptz completed_at
        review_outcome outcome
        text reason
        text method
        text reference
        timestamptz decided_at
    }

    User ||--|| AuthTokenVersion : "owns"
    User ||--o{ AuditLog : "performs"
    User o|--o| Candidate : "has profile"
    Candidate ||--o{ SourceDocument : "has"
    Candidate ||--o{ Claim : "has"
    Candidate ||--o{ EvidenceDocument : "owns"
    SourceDocument ||--o{ SourceOccurrence : "has"
    Claim ||--o{ SourceOccurrence : "has"
    Claim ||--o{ ClaimValueHistory : "has"
    Claim ||--o{ NormalizationDecision : "has"
    Claim ||--o{ Conflict : "has"
    Claim ||--o{ ClaimEvidence : "has"
    EvidenceDocument ||--o{ ClaimEvidence : "supports"
    CanonicalTerm ||--o{ Alias : "has"
    CanonicalTerm ||--o{ NormalizationDecision : "maps"
    Conflict ||--o{ ConflictValue : "has"
    Alias ||--o{ AliasReview : "proposed in"
    EvidenceDocument ||--o{ CertificateReview : "verified in"
```
