# Document parsing module plan (Part 1)

## Goal

Turn an uploaded CV (PDF or DOCX) into structured text where every line knows
its page and position, store the result, and keep successful pages when part
of a file fails.

## Scope

- Extract text from PDF and DOCX source documents.
- Keep line structure, page numbers, and on-page coordinates for PDF.
- Store one extraction result per document.
- Keep successful pages and record failed ones.
- Leave AI extraction, claims, source occurrences, OCR for scanned CVs,
  LinkedIn exports, certificate data from evidence documents, and public
  endpoints to Part 2 or later modules.

## Design decisions

- Add a `parsing` module that receives file bytes and a media type. It does
  not know where the file came from, so it works before the upload module is
  finished and later reads files through `documentsService` without changes.
- Parse `source` documents only; `evidence` documents are not parsed in Part 1.
- Use the Strategy pattern: one `DocumentParser` contract with a PDF parser
  and a DOCX parser, chosen by media type. A new format adds one parser without
  changing the rest.
- Use `pdfjs-dist` for PDF. It returns text with page numbers and coordinates.
- Group PDF text into lines. Each line keeps its text, its bounding box, and
  the original text pieces inside it, so any word can be traced to its page
  and position.
- Store coordinates from the top-left corner, with each page's width and
  height, so a client can highlight text on the page.
- Use `mammoth` for DOCX. Word files have no fixed pages or coordinates, so
  DOCX results contain ordered paragraphs with `pageNumber = null`.
- Treat a page without a text layer (scanned image) as a page failure
  `NO_TEXT_LAYER`, not a file failure.
- Fail the whole file only when it cannot be opened: `UNREADABLE` or
  `PASSWORD_PROTECTED`.
- Limit the number of PDF pages to protect the server; agree on the exact
  limit together with the upload size limit.
- Store the extracted content as JSONB. It is read as a whole and never
  searched with SQL; search happens later on structured claims.
- Create `document_extractions` with a plain `document_id` column now. When
  the `documents` table exists, one small migration adds the foreign key; no
  parsing code changes.
- Record the parser library and version with every result.

## Relation to the documents table

The `documents` module merges the ERD's `SourceDocument` and
`EvidenceDocument` into one `documents` table with `purpose = source | evidence`.
Parsing fields from `SourceDocument` move as follows:

| ERD field | New location |
| --- | --- |
| `parsed_content` | `document_extractions.content` |
| `failed_portions` | `document_extractions.failures` |
| `processing_status` | `documents.status` |
| `error_details` | Short code in `documents.failure_code`; details in `document_extractions.failures` |
| `attempt_count` | Part 2, with retries |
| `unmapped_data` | Part 2, with AI extraction |

File fields such as name, format, size, hash, and storage reference stay in
`documents`. `EvidenceDocument` certificate fields belong to the later evidence
and verification module.

## Output contract

- `status`: `succeeded`, `partial`, or `failed`
- `format`: `pdf` or `docx`
- `pageCount`: number of pages, or `null` for DOCX
- `pages`: for each page, its number, width, height, and lines; each line has
  its text, bounding box, and text pieces
- `paragraphs`: for DOCX, ordered paragraphs with their index and text
- `failures`: failed page numbers with an error code
- `parserVersion`: library name and version

## Data model

```mermaid
erDiagram
    DOCUMENTS ||--o| DOCUMENT_EXTRACTIONS : "extracted into (FK added later)"

    DOCUMENTS {
        uuid document_id PK
        document_purpose purpose
        document_status status
    }
    DOCUMENT_EXTRACTIONS {
        uuid extraction_id PK
        uuid document_id UK
        extraction_status status
        document_format format
        integer page_count "nullable"
        jsonb content
        jsonb failures
        text parser_version
        timestamptz created_at
    }
```

- `extraction_status`: `succeeded`, `partial`, `failed`
- `document_format`: `pdf`, `docx`

## Parsing flow

```mermaid
sequenceDiagram
    participant Caller as Tests now / documents service later
    participant Parser as Parsing service
    participant Database

    Caller->>Parser: parse(documentId, bytes, mediaType)
    alt File cannot be opened
        Parser->>Database: Save failed extraction
    else File opens
        loop Each page or paragraph block
            Parser->>Parser: Extract lines, page number, coordinates
            Parser->>Parser: Record page failure if extraction fails
        end
        Parser->>Database: Save succeeded or partial extraction
    end
    Parser-->>Caller: Extraction result
```

## Implementation

- [ ] Review this plan with the team.
- [ ] Add PDF and DOCX test fixtures.
- [ ] Define the input and output types.
- [ ] Add the PDF reader with pages, lines, and coordinates.
- [ ] Add the DOCX reader with ordered paragraphs.
- [ ] Add partial results and error codes.
- [ ] Add `document_extractions`, its migration, and the repository.
- [ ] Update the data model documentation.

## Verification

- [ ] Test single-page, multi-page, and two-column PDFs.
- [ ] Test that each line has the correct page number and a box inside the page.
- [ ] Test scanned, corrupt, and password-protected PDFs.
- [ ] Test DOCX paragraphs and tables.
- [ ] Test that partial results keep successful pages.
- [ ] Test saving and reading an extraction.
- [ ] Run focused tests, `npm test`, and `npm run build`.
- [ ] Have another team member test and review the code.
