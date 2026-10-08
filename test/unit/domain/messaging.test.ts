import { describe, expect, it } from 'bun:test';
import { WagerTransactionProcessed } from '../../../src/domain/events/wagering-events';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { BackoffPolicy } from '../../../src/domain/shared/backoff-policy';
import { apply, later, NOW, openWallet, wager } from '../../support/domain-builders';

const publishRetry = BackoffPolicy.exponential({ baseDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 1_000 });

function enqueuedEvent(): OutboxMessage {
  const { wallet } = openWallet('100.00');
  const bet = wager();
  apply(wallet, bet);
  return OutboxMessage.enqueue(WagerTransactionProcessed.from(bet, { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: NOW }));
}

describe('OutboxMessage', () => {
  it('enqueue keeps the eventId as id and the serialized envelope as payload, due immediately', () => {
    const message = enqueuedEvent();

    expect(message.id).toBe('evt-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.payload).toMatchObject({ eventId: 'evt-1', eventType: 'WagerTransactionProcessed', version: 1 });
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
  });

  it('a failed publish is retried later, with growing delays', () => {
    const message = enqueuedEvent();

    message.scheduleRetry(NOW, publishRetry);
    expect(message.attempts).toBe(1);
    expect(message.isDue(later(499))).toBe(false);
    expect(message.isDue(later(500))).toBe(true);

    message.scheduleRetry(later(500), publishRetry);
    expect(message.nextAttemptAt).toEqual(later(1_500));
  });

  it('once published it is no longer pending nor due, and cannot be published or retried again', () => {
    const message = enqueuedEvent();

    message.markPublished(later(10));

    expect(message.isPending()).toBe(false);
    expect(message.isDue(later(60_000))).toBe(false);
    expect(() => message.markPublished(later(20))).toThrow();
    expect(() => message.scheduleRetry(later(20), publishRetry)).toThrow();
  });
});

describe('InboxMessage', () => {
  const received = () => InboxMessage.receive({ messageId: 'msg-1', consumerName: 'wager-consumer', payloadHash: 'abc', receivedAt: NOW });

  it('is received unprocessed and processed exactly once', () => {
    const message = received();
    expect(message.isProcessed()).toBe(false);

    message.markProcessed(later(5));

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(later(5));
    expect(() => message.markProcessed(later(6))).toThrow();
  });

  it('tells a redelivery (same payload) from a poison message (same id, other payload)', () => {
    const message = received();

    expect(message.matchesPayload('abc')).toBe(true);
    expect(message.matchesPayload('xyz')).toBe(false);
  });
});

describe('BackoffPolicy', () => {
  const policy = BackoffPolicy.exponential({ baseDelayMs: 1_000, maxDelayMs: 5_000, maxAttempts: 4 });

  it('doubles the delay after each failure, up to the cap', () => {
    expect([1, 2, 3, 4, 5].map((attempts) => policy.delayAfter(attempts))).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
  });

  it('is exhausted when attempts reach the limit', () => {
    expect(policy.isExhausted(3)).toBe(false);
    expect(policy.isExhausted(4)).toBe(true);
  });

  it.each([
    { baseDelayMs: 0, maxDelayMs: 1, maxAttempts: 1 },
    { baseDelayMs: 1.5, maxDelayMs: 2, maxAttempts: 1 },
    { baseDelayMs: 10, maxDelayMs: 5, maxAttempts: 1 },
    { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 0 },
  ])('rejects an invalid configuration %p', (config) => {
    expect(() => BackoffPolicy.exponential(config)).toThrow(RangeError);
  });
});
