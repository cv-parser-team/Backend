# Functional requirements

This version-controlled document is the implementation source of truth for
LuminaCV's functional requirements. Update it in the same pull request as any
intentional behavior change, and reference requirement IDs from issues, tests,
and design decisions where useful.

## 01 — Source collection

| ID | Requirement |
| --- | --- |
| `FR-SC-01` | Accept CVs in PDF/DOCX and supported LinkedIn data exports. |
| `FR-SC-02` | Allow candidates to upload multiple documents in one operation or individually, including different CV versions. |
| `FR-SC-03` | Reject unsupported formats, oversized files, and corrupted or unreadable files. |
| `FR-SC-04` | Display each uploaded source with filename, source type, upload date, and processing status. |
| `FR-SC-05` | Allow candidates to delete uploaded sources; before deletion, identify dependent profile claims and explain the potential impact. |
| `FR-SC-06` | Keep the original contents of all uploaded files unchanged. |
| `FR-SC-07` | Automatically initiate parsing when a valid source is uploaded. |
| `FR-SC-08` | Process each source independently before merging extracted information into the unified candidate profile. |

## 02 — Document parsing

| ID | Requirement |
| --- | --- |
| `FR-DP-01` | Extract text from PDF and DOCX files using PDF.js and Mammoth, preserving available structural and positional information. |
| `FR-DP-02` | Apply OCR selectively to pages or regions with missing or unusable extracted text. |
| `FR-DP-03` | Use AI to reconstruct logical reading order, including multi-column layouts and tables, without inventing or modifying source content. |
| `FR-DP-04` | Produce structured text blocks containing content, reading order, page references, and available positional information. |
| `FR-DP-05` | Preserve successfully parsed content after partial failures and identify failed portions for retry or downstream handling. |

## 03 — Data extraction

| ID | Requirement |
| --- | --- |
| `FR-DE-01` | Use AI to extract structured candidate information from parsed CV content, including skills, experience, education, certifications, and projects. |
| `FR-DE-02` | Preserve original extracted values and source references, including available text locations. |
| `FR-DE-03` | Suggest inferred skills or competencies supported by CV content, requiring candidate approval before inclusion in the profile. |
| `FR-DE-04` | Suggest interpretations of ambiguous information and require candidate confirmation before applying them. |
| `FR-DE-05` | Flag low-confidence or invalid extracted information for candidate review and correction. |
| `FR-DE-06` | Preserve information outside the supported profile schema separately for future use. |
| `FR-DE-07` | Consolidate clearly identical claims within the same CV while retaining references to all occurrences; defer normalization to its dedicated stage. |
| `FR-DE-08` | Retain successfully extracted information after partial extraction failures, report failed portions, and support retry or manual completion. |
| `FR-DE-09` | Allow candidates to accept, edit, or reject extracted claims requiring review; exclude unresolved claims from the accepted profile. |

## 04 — Alias normalization

| ID | Requirement |
| --- | --- |
| `FR-AN-01` | Normalize skills, job titles, degrees, and certifications to canonical terms; exclude educational institutions. |
| `FR-AN-02` | Follow this order: exact canonical match → approved alias → fuzzy match → AI contextual match → candidate decision. Stop when a reliable match is found. |
| `FR-AN-03` | Automatically apply high-confidence matches, including spelling corrections. For uncertain terms, let candidates choose or search for an existing canonical term, enter or keep the original value, or remove the claim. |
| `FR-AN-04` | AI may propose a new alias for an existing canonical term or a new canonical term. Automatically send every AI-generated dictionary proposal for human review; activate it globally only after approval. |
| `FR-AN-05` | Reuse approved alias-to-canonical links without repeated AI processing. Candidate-selected links apply only to that candidate's profile unless approved for global use. |
| `FR-AN-06` | When a candidate opens their profile, check unmatched original values for newly available canonical matches and suggest links. Candidates can accept, reject, or ignore suggestions without blocking profile loading. |
| `FR-AN-07` | Consolidate equivalent duplicate claims after normalization, retaining all source references and evidence. Preserve original values and normalization history; do not overwrite verified information when mappings change. |

## 05 — Conflict detection

| ID | Requirement |
| --- | --- |
| `FR-CD-01` | Use similarity-based matching to identify claims that may describe the same record, considering employer, job title, and employment dates. |
| `FR-CD-02` | When matching is uncertain or multiple possible matches exist, ask the candidate whether claims represent the same record, different records, or a combination. |
| `FR-CD-03` | Detect meaningful contradictions between claims about the same record and of the same type. Ignore missing values and compatible partial dates. |
| `FR-CD-04` | Compare approved normalized values when available. Otherwise compare original values using semantic similarity, requesting clarification when equivalence is uncertain. |
| `FR-CD-05` | Distinguish incompatible values (conflicts) from suspicious or uncertain differences (warnings), including overlapping employment and uncertain job-title equivalence. |
| `FR-CD-06` | Interpret Present using the source's reliable creation or update date. If that date is unknown, ignore differences between Present and a specified end date. |
| `FR-CD-07` | Require candidate confirmation before using low-confidence extracted values for conflict detection. |
| `FR-CD-08` | Recheck affected claims whenever extraction results, normalization mappings, or new evidence change relevant information. |
| `FR-CD-09` | Maintain one conflict per record and field, containing all contradictory values and source references rather than creating duplicates. |
| `FR-CD-10` | Reuse prior resolution decisions when new sources repeat rejected values; reopen only when materially new information could change the decision. |
| `FR-CD-11` | Allow candidates to clarify uncertain matches and warnings. Apply each clarification to the specific record only, without changing global aliases. |
| `FR-CD-12` | Treat edits to final profile fields as conflict-resolution decisions while preserving the original extracted claims. |

## 06 — Evidence management

| ID | Requirement |
| --- | --- |
| `FR-EV-01` | Allow candidates to upload PDF, DOCX, and image documents as evidence for skills, employment, education, and certifications. |
| `FR-EV-02` | Allow uploaded documents to be reused across multiple claims without uploading them again. |
| `FR-EV-03` | Allow candidates to manually select which existing claims each document supports. AI may suggest claims, but candidates must confirm attachments. |
| `FR-EV-04` | Allow multiple documents to be attached to one claim without checking their relevance. |
| `FR-EV-05` | Show attached documents under each claim and allow candidates to remove individual attachments without deleting the documents. |
| `FR-EV-06` | Allow candidates to delete uploaded evidence documents, removing their attachments from all associated claims. |
| `FR-EV-07` | Preserve existing documents when new evidence is uploaded and keep evidence attachments unchanged when a claim is edited. |
| `FR-EV-08` | The system shall automatically extract the certificate title, issuer, issue date, expiration date (if available), and credential ID from uploaded certificates, allowing candidates to review and correct the extracted information. |

## 07 — Profile output

| ID | Requirement |
| --- | --- |
| `FR-PO-01` | Generate a structured JSON profile containing personal information, skills, employment history, education, and certifications. |
| `FR-PO-02` | Use canonical values where available and preserve original values for claims that could not be normalized. |
| `FR-PO-03` | For unresolved conflicts, include the candidate’s selected value and a warning that the conflict remains unresolved. |
| `FR-PO-04` | Include references to original source documents for each profile claim. |
| `FR-PO-05` | Include evidence metadata and references so authorized agents can retrieve supporting documents. |
| `FR-PO-06` | Expose a REST API that allows authorized external AI agents to retrieve the complete candidate profile as JSON. |
| `FR-PO-07` | Ensure API responses reflect the latest saved profile changes. |

## 08 — Authentication and authorization

| ID | Requirement |
| --- | --- |
| `FR-AA-01` | Allow candidates to register and sign in using email and password, with email verification and password recovery. |
| `FR-AA-02` | Use short-lived access tokens and rotating refresh tokens; support logout and session revocation. |
| `FR-AA-03` | Enforce Candidate, Reviewer, and Admin roles with role-specific permissions. |
| `FR-AA-04` | Restrict candidates to accessing and managing their own profiles, uploaded sources, and evidence. |
| `FR-AA-05` | Allow reviewers to approve or reject normalization proposals without accessing private candidate data. |
| `FR-AA-06` | Allow candidates to permanently delete their accounts and associated personal data, including uploaded documents, evidence, sessions, and API credentials; invalidate access immediately. |

## 09 — Profile management

| ID | Requirement |
| --- | --- |
| `FR-PM-01` | Allow candidates to manually add information without supporting documents. |
| `FR-PM-02` | Preserve original extracted values and source references when candidates edit profile information. |
| `FR-PM-03` | Permanently delete removed profile records and their extracted information, without deleting source documents. |
| `FR-PM-04` | Allow deleted information to reappear when extracted from newly uploaded documents. |
| `FR-PM-05` | Allow candidates to select an existing canonical value or enter a custom value when editing normalized information. |
| `FR-PM-06` | Suggest merging duplicate records added manually, requiring candidate confirmation. |
| `FR-PM-07` | Display a profile completeness percentage and suggest improvements based on missing information. |

## 10 — Reviewer management

| ID | Requirement |
| --- | --- |
| `FR-RV-01` | Provide a shared queue of pending alias proposals and certificate verification cases, showing only non-sensitive details before a case is claimed. |
| `FR-RV-02` | Allow reviewers to claim and release cases. Only the assigned reviewer can access full case details; prevent simultaneous claims. |
| `FR-RV-03` | Allow reviewers to approve, reject, edit, or redirect AI-generated alias and canonical term proposals to existing canonical terms. |
| `FR-RV-04` | Apply reviewer-approved dictionary proposals globally for future normalization. For existing unmatched claims, suggest new matches when candidates open their profiles and require their approval before applying. |
| `FR-RV-05` | Allow reviewers to inspect assigned certificates, extracted metadata, and available verification information. |
| `FR-RV-06` | Allow reviewers to record certificate outcomes as verified, failed, or inconclusive, with reason, method, reference, and date. Mark verified only after authoritative issuer confirmation. |
| `FR-RV-07` | Record reviewer identity, decision, reason, and timestamp in an audit history. |
| `FR-RV-08` | Prevent reviewers from directly modifying candidate profile information or resolving conflicts between candidate claims. |

## 11 — Admin management

| ID | Requirement |
| --- | --- |
| `FR-AD-01` | Allow admins to create, deactivate, and reactivate reviewer accounts. |
| `FR-AD-02` | Allow admins to view all review cases and release or reassign claimed cases. Sensitive candidate information shall be accessible only when handling the relevant case. |
| `FR-AD-03` | Allow admins to reopen completed reviews, preserving previous decisions and recording the reason. |
| `FR-AD-04` | Allow admins to create, edit, merge, or deactivate canonical terms and aliases while preserving existing candidate claims and normalization history. |
| `FR-AD-05` | Provide admins with review queue statistics, including pending, claimed, and completed cases. |
