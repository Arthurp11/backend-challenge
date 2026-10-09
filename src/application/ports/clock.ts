/** Time source. Injected so the domain and use cases never read the system clock directly. */
export interface Clock {
  now(): Date;
}
