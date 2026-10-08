/**
 * Base for violations of domain rules. `code` is stable and machine-readable, so the HTTP layer and
 * the SQS consumer can map errors to responses and failure codes without parsing messages.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
