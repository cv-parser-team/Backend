import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { documents } from './documents.table.js';

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

describe('documents table constraints', () => {
  const dialect = new PgDialect();
  const tableConfig = getTableConfig(documents);
  const constraints = new Map(
    tableConfig.checks.map((constraint) => [
      constraint.name,
      normalizeSql(dialect.sqlToQuery(constraint.value).sql)
    ])
  );

  it('prevents duplicate content for the same owner and purpose', () => {
    const duplicateIndex = tableConfig.indexes.find(
      (index) => index.config.name === 'documents_owner_purpose_sha256_unique'
    );

    expect(duplicateIndex?.config.unique).toBe(true);
    expect(
      duplicateIndex?.config.columns.map((column) =>
        'name' in column ? column.name : undefined
      )
    ).toEqual(['owner_user_id', 'purpose', 'sha256']);
  });

  it('enforces valid persisted document metadata', () => {
    expect(constraints.get('documents_byte_size_positive')).toBe(
      '"documents"."byte_size" > 0'
    );
    expect(constraints.get('documents_original_filename_length')).toBe(
      'length(btrim("documents"."original_filename")) between 1 and 255'
    );
    expect(constraints.get('documents_sha256_format')).toBe(
      '"documents"."sha256" ~ \'^[0-9a-f]{64}$\''
    );
    expect(constraints.get('documents_storage_key_not_blank')).toBe(
      'length(btrim("documents"."storage_key")) > 0'
    );
  });

  it('restricts media types and source-document formats', () => {
    expect(constraints.get('documents_media_type_supported')).toContain(
      "'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png'"
    );
    expect(
      constraints.get('documents_purpose_media_type_compatible')
    ).toContain(
      `"documents"."purpose" = 'evidence' or "documents"."media_type" in ( 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' )`
    );
  });

  it('requires a failure code only for failed documents', () => {
    expect(constraints.get('documents_failure_code_status')).toBe(
      `( "documents"."status" = 'failed' and "documents"."failure_code" is not null ) or ( "documents"."status" <> 'failed' and "documents"."failure_code" is null )`
    );
  });
});
