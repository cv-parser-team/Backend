import { describe, expect, it } from 'vitest';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import {
  DatabaseConnectionError,
  DatabaseError,
  ForeignKeyViolationError,
  isTransientDatabaseError,
  mapDatabaseError,
  NotNullViolationError,
  TransientDatabaseError,
  UniqueConstraintViolationError
} from './database.errors.js';

function mapped(error: unknown): unknown {
  try {
    mapDatabaseError(error, 'Claim');
  } catch (mappedError) {
    return mappedError;
  }
  throw new Error('mapDatabaseError did not throw');
}

describe('database error mapping', () => {
  it.each([
    ['40001', 'serialization failure'],
    ['40P01', 'deadlock'],
    ['55P03', 'lock not available']
  ])('maps %s (%s) to a transient error', (code) => {
    const error = mapped({ code, message: 'driver message' });

    expect(error).toBeInstanceOf(TransientDatabaseError);
    expect(error).toMatchObject({
      statusCode: 503,
      code: 'TRANSIENT_DATABASE_ERROR'
    });
  });

  it.each([
    ['23505', UniqueConstraintViolationError],
    ['23503', ForeignKeyViolationError],
    ['23502', NotNullViolationError],
    ['ECONNREFUSED', DatabaseConnectionError]
  ])('keeps mapping %s as before', (code, errorClass) => {
    expect(mapped({ code })).toBeInstanceOf(errorClass);
  });

  it('maps unknown driver errors to a generic database error', () => {
    const error = mapped({ code: 'XX000', message: 'internal error' });

    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).not.toBeInstanceOf(TransientDatabaseError);
  });

  it('passes application errors through unchanged', () => {
    const notFound = new RecordNotFoundError('Claim');

    expect(mapped(notFound)).toBe(notFound);
  });
});

describe('transient database errors', () => {
  it.each([
    [new TransientDatabaseError(), true],
    [new DatabaseConnectionError(), true],
    [new UniqueConstraintViolationError('duplicate'), false],
    [new DatabaseError('unknown'), false],
    [new RecordNotFoundError('Claim'), false],
    [new Error('plain'), false],
    [{ code: '40P01', message: 'deadlock detected' }, true],
    [{ code: '40001' }, true],
    [{ code: 'ECONNREFUSED' }, true],
    [{ code: '23505' }, false],
    [{ message: 'no code' }, false]
  ])('classifies %o as transient: %s', (error, transient) => {
    expect(isTransientDatabaseError(error)).toBe(transient);
  });
});
