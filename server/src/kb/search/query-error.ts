export type QueryErrorCode = 'kb_not_published' | 'kb_release_unavailable' | 'kb_not_found' | 'kb_section_not_found' | 'kb_section_ambiguous' | 'kb_integrity_error' | 'kb_index_failed' | 'invalid_request' | 'invalid_cursor' | 'raw_unavailable' | 'raw_unreadable' | 'raw_not_found' | 'raw_changed' | 'raw_line_too_large';
export class QueryError extends Error {
  constructor(public readonly code: QueryErrorCode, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message); this.name = 'QueryError';
  }
  toJSON(): { error: { code: QueryErrorCode; message: string } & Record<string, unknown> } {
    return { error: { ...this.details, code: this.code, message: this.message } };
  }
}
export function invalid(field: string, message = '参数无效'): never { throw new QueryError('invalid_request', message, { field }); }
