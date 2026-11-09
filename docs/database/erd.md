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
        text headline
        text summary
        text phone
        text location
        text contact_email
        jsonb profile_links
        timestamptz created_at
        timestamptz updated_at
    }
    Document {
        uuid document_id PK
        uuid owner_user_id FK
        document_purpose purpose
        text original_filename
        text media_type
        bigint byte_size
        text sha256
        text storage_key UK
        document_status status
        text failure_code "nullable"
        timestamptz created_at
        timestamptz updated_at
    }
    DocumentExtraction {
        uuid extraction_id PK
        uuid document_id FK, UK
        extraction_status status
        document_format format
        integer page_count "nullable"
        jsonb content
        jsonb failures
        text parser_version
        integer attempt_count "Part 2"
        jsonb unmapped_data
        timestamptz created_at
        timestamptz updated_at
    }
    EvidenceDetails {
        uuid document_id PK, FK
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
    SkillDetails {
        uuid claim_id PK, FK
        text name
    }
    EmploymentDetails {
        uuid claim_id PK, FK
        text employer
        text job_title
        date start_date
        date end_date
        text location
        text description
        text[] skills
    }
    EducationDetails {
        uuid claim_id PK, FK
        text institution
        text degree
        text field_of_study
        date start_date
        date end_date
    }
    CertificationDetails {
        uuid claim_id PK, FK
        text title
        text issuer
        date issue_date
        date expiry_date
        text credential_id
    }
    LanguageDetails {
        uuid claim_id PK, FK
        text name
        text proficiency
    }
    ProjectDetails {
        uuid claim_id PK, FK
        text name
        text description
        text role
        text url
        date start_date
        date end_date
        text[] skills
    }
    ClaimRevision {
        uuid revision_id PK
        uuid claim_id FK
        jsonb previous_values
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
        uuid document_id PK, FK
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
        uuid document_id FK
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
    User ||--o{ Document : "owns"
    Candidate ||--o{ Claim : "has"
    Document ||--o| DocumentExtraction : "source text"
    Document ||--o| EvidenceDetails : "evidence metadata"
    Document ||--o{ SourceOccurrence : "has"
    Claim ||--o{ SourceOccurrence : "has"
    Claim ||--o| SkillDetails : "skill details"
    Claim ||--o| EmploymentDetails : "employment details"
    Claim ||--o| EducationDetails : "education details"
    Claim ||--o| CertificationDetails : "certification details"
    Claim ||--o| LanguageDetails : "language details"
    Claim ||--o| ProjectDetails : "project details"
    Claim ||--o{ ClaimRevision : "archives"
    Claim ||--o{ NormalizationDecision : "has"
    Claim ||--o{ Conflict : "has"
    Claim ||--o{ ClaimEvidence : "has"
    Document ||--o{ ClaimEvidence : "supports"
    CanonicalTerm ||--o{ Alias : "has"
    CanonicalTerm ||--o{ NormalizationDecision : "maps"
    Conflict ||--o{ ConflictValue : "has"
    Alias ||--o{ AliasReview : "proposed in"
    Document ||--o{ CertificateReview : "verified in"
```
