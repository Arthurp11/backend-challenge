/** Generates ids for new records (uuidv7 in production: time-ordered, index friendly). */
export interface IdGenerator {
  next(): string;
}
