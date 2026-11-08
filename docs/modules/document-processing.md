# Asynchronous document processing pipeline

## Goal

Process uploaded source documents asynchronously through RabbitMQ while keeping
storage, parsing, and claim extraction as separate concerns.

## Boundaries

- `documents` owns file storage, metadata, and document lifecycle status.
- `document-processing` owns job scheduling, idempotency, retries, and workflow
  orchestration.
- `parsing` converts PDF or DOCX content into structured text blocks.
- `claim-extraction` later converts parsed blocks into profile claims.
- `infrastructure/messaging` contains RabbitMQ-specific code.
- `workers` compose dependencies and run consumers.

## Proposed structure

```text
src/
├── infrastructure/
│   └── messaging/
│       ├── message-broker.ts
│       └── rabbitmq.ts
├── modules/
│   ├── document-processing/
│   │   ├── document-processing.table.ts
│   │   ├── document-processing.repository.ts
│   │   ├── parse-document.job.ts
│   │   ├── parse-document.handler.ts
│   │   └── index.ts
│   └── parsing/
│       ├── parser.ts
│       ├── parsing.types.ts
│       ├── parsing.table.ts
│       ├── pdf.parser.ts
│       └── docx.parser.ts
└── workers/
    └── main.ts
```

Keep the parsing module flat until additional parser concerns justify
subdirectories.

## Job contract

```ts
interface ParseDocumentJob {
  version: 1;
  jobId: string;
  documentId: string;
}
```

Queue messages must not contain file bytes, storage paths, parsed content, or
profile claims.

## Components

```mermaid
flowchart LR
    Documents[Documents module] -->|schedule| Processing[Document processing]
    Processing --> Jobs[(Processing jobs)]
    Processing -->|publish| RabbitMQ[(RabbitMQ)]
    RabbitMQ --> Worker[Worker]
    Worker --> Handler[Parse job handler]
    Handler -->|open content and update status| Documents
    Handler --> Parser[Parsing module]
    Parser --> Parsed[(Parsed content)]
```

## Successful processing

```mermaid
sequenceDiagram
    actor Candidate
    participant Documents
    participant Processing
    participant Database
    participant RabbitMQ
    participant Worker
    participant Handler
    participant Parsing

    Candidate->>Documents: Upload source
    Documents->>Processing: Schedule document ID
    Processing->>Database: Create queued job
    Processing->>RabbitMQ: Publish job ID and document ID
    RabbitMQ-->>Worker: Deliver job
    Worker->>Handler: Handle job
    Handler->>Processing: Claim job
    Processing->>Database: Atomically mark job processing
    Processing-->>Handler: Job claimed
    Handler->>Documents: Mark processing and open content
    Documents-->>Handler: Document stream and metadata
    Handler->>Parsing: Parse and store document content
    Parsing->>Database: Replace parsed output
    Parsing-->>Handler: Parsing completed
    Handler->>Documents: Mark document ready
    Documents->>Database: Update document status
    Handler->>Processing: Complete job
    Processing->>Database: Mark job completed
    Handler-->>Worker: Processing completed
    Worker->>RabbitMQ: Acknowledge message
```

## Job lifecycle

```mermaid
stateDiagram-v2
    [*] --> queued: job created
    queued --> processing: worker claims job
    processing --> completed: parsing succeeds
    processing --> retrying: retryable failure
    retrying --> queued: delay expires
    processing --> failed: permanent failure
    retrying --> failed: retry limit reached
    completed --> [*]
    failed --> [*]: message dead-lettered
```

## Suggested data model

```mermaid
erDiagram
    DOCUMENTS {
        uuid document_id PK
        document_status status
    }
    DOCUMENT_PROCESSING_JOBS {
        uuid job_id PK
        uuid document_id FK
        processing_job_status status
        integer attempt_count
        text failure_code "nullable"
        timestamptz available_at
        timestamptz locked_until "nullable"
        timestamptz created_at
        timestamptz updated_at
    }

    DOCUMENTS ||--o{ DOCUMENT_PROCESSING_JOBS : schedules
```

The processing-job table provides durable idempotency, leasing, and retry state.

### Enumerations

- `document_status`: `stored`, `processing`, `ready`, `failed`, `deleting`
- `processing_job_status`: `queued`, `processing`, `retrying`, `completed`,
  `failed`

## Requirements

- Publish a versioned job containing only `jobId` and `documentId`.
- Move documents through `stored -> processing -> ready | failed`.
- Claim jobs atomically so duplicate deliveries cannot process concurrently.
- Use bounded retries followed by dead-lettering.
- Recover jobs abandoned after a worker crash by using a processing lease.
- Support graceful shutdown and structured job logging.
- Use an injected parser interface and a fake parser in processing tests.
- Add an outbox before production if document creation and publication must be
  guaranteed as one operation.

