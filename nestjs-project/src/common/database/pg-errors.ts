import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

interface PgErrorFields {
  code?: string;
  detail?: string;
}

export function isPgUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & PgErrorFields;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}
