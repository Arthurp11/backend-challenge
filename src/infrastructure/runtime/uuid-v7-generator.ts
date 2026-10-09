import type { IdGenerator } from '../../application/ports/id-generator';

/** uuidv7: time-ordered (index friendly, sortable by creation) and monotonic within the process. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
