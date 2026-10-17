import { randomUUID } from 'node:crypto';
import type { Paise } from './money';

export type ChargeRequest = {
  orderId: string;
  amountPaise: Paise;
};

export type ChargeResult = {
  paymentId: string;
};

export interface PaymentGateway {
  charge(request: ChargeRequest): ChargeResult;
}

/**
 * Stand-in for a payment provider. Successful checkout is treated as
 * captured payment. The interface exists so a real authorize/capture flow
 * can replace this without changing inventory or coupon invariants.
 */
export class AlwaysSucceedPayment implements PaymentGateway {
  charge(_request: ChargeRequest): ChargeResult {
    return { paymentId: `pay_${randomUUID()}` };
  }
}

export class RejectPayment implements PaymentGateway {
  constructor(private readonly reason = 'card_declined') {}
  charge(_request: ChargeRequest): ChargeResult {
    throw new Error(this.reason);
  }
}
