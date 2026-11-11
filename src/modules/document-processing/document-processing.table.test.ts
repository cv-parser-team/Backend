import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  documentProcessingJobs,
  processingJobStatus
} from './document-processing.table.js';
import {
  PARSE_DOCUMENT_JOB_VERSION
} from './parse-document.job.js';
import type { ParseDocumentJob } from './parse-document.job.js';

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

describe('parse document job contract', () => {
  it('uses the first contract version', () => {
    const job: ParseDocumentJob = {
      version: PARSE_DOCUMENT_JOB_VERSION,
      jobId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222'
    };

    expect(job).toEqual({
      version: 1,
      jobId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222'
    });
  });
});

describe('document processing jobs table', () => {
  const dialect = new PgDialect();
  const tableConfig = getTableConfig(documentProcessingJobs);

  it('defines every processing lifecycle status', () => {
    expect(processingJobStatus.enumValues).toEqual([
      'queued',
      'processing',
      'retrying',
      'completed',
      'failed'
    ]);
  });

  it('starts new jobs queued and immediately available', () => {
    expect(documentProcessingJobs.status.default).toBe('queued');
    expect(documentProcessingJobs.attemptCount.default).toBe(0);
    expect(documentProcessingJobs.availableAt.hasDefault).toBe(true);
    expect(documentProcessingJobs.lockedUntil.notNull).toBe(false);
    expect(documentProcessingJobs.failureCode.notNull).toBe(false);
  });

  it('deletes processing history with its document', () => {
    const [foreignKey] = tableConfig.foreignKeys;

    expect(tableConfig.foreignKeys).toHaveLength(1);
    expect(getTableConfig(foreignKey!.reference().foreignTable).name).toBe(
      'documents'
    );
    expect(foreignKey!.onDelete).toBe('cascade');
  });

  it('indexes runnable jobs, expired leases, and document history', () => {
    const indexes = new Map(
      tableConfig.indexes.map((tableIndex) => [
        tableIndex.config.name,
        tableIndex.config.columns.map((column) =>
          'name' in column ? column.name : undefined
        )
      ])
    );

    expect(indexes.get('document_processing_jobs_runnable_idx')).toEqual([
      'status',
      'available_at'
    ]);
    expect(indexes.get('document_processing_jobs_lease_idx')).toEqual([
      'status',
      'locked_until'
    ]);
    expect(indexes.get('document_processing_jobs_document_id_idx')).toEqual([
      'document_id'
    ]);
  });

  it('allows one active job per document', () => {
    const activeJobIndex = tableConfig.indexes.find(
      (tableIndex) =>
        tableIndex.config.name === 'document_processing_jobs_active_document_unique'
    );

    expect(activeJobIndex?.config.unique).toBe(true);
    expect(
      activeJobIndex?.config.columns.map((column) =>
        'name' in column ? column.name : undefined
      )
    ).toEqual(['document_id']);
    expect(
      activeJobIndex?.config.where
        ? normalizeSql(dialect.sqlToQuery(activeJobIndex.config.where).sql)
        : undefined
    ).toBe(
      `"document_processing_jobs"."status" in ('queued', 'processing', 'retrying')`
    );
  });

  it('prevents negative attempt counts', () => {
    const constraint = tableConfig.checks.find(
      (candidate) =>
        candidate.name ===
        'document_processing_jobs_attempt_count_nonnegative'
    );

    expect(
      constraint
        ? normalizeSql(dialect.sqlToQuery(constraint.value).sql)
        : undefined
    ).toBe('"document_processing_jobs"."attempt_count" >= 0');
  });
});
