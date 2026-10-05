/** Domain rule violation. `code` is stable and safe to return to API clients. */
export class DomainError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}
