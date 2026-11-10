export const READER_ERROR_CODES = [
  'invalid_file',
  'unsupported_schema',
  'capacity',
  'invalid_region',
  'read_failed',
] as const;

export type ReaderErrorCode = (typeof READER_ERROR_CODES)[number];

export class ReaderError extends Error {
  readonly code: ReaderErrorCode;

  constructor(code: ReaderErrorCode, message: string) {
    super(message);
    this.name = 'ReaderError';
    this.code = code;
  }
}
