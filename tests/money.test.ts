import { describe, expect, it } from 'vitest';
import { netAfterDiscount, percentOffPaise } from '../src/money';

describe('money', () => {
  it('applies percent-off with floor rounding and never goes negative', () => {
    expect(percentOffPaise(49900, 10)).toBe(4990);
    expect(percentOffPaise(1, 10)).toBe(0);
    expect(percentOffPaise(199, 10)).toBe(19);
    expect(netAfterDiscount(199, 19)).toBe(180);
  });
});
