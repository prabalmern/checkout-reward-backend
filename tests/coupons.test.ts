
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/database';
import { createApp } from '../src/http/app';
import { RejectPayment } from '../src/payment';
import { createCartWithItem, startService } from './helpers';

async function placeOrders(app: Express, count: number) {
  for (let i = 0; i < count; i += 1) {
    const cartId = await createCartWithItem(app, 'p-cable', 1);
    await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set('Idempotency-Key', `placed-order-${randomUUID()}`)
      .send({})
      .expect(201);
  }
}

describe('coupons', () => {
  it('generates one coupon per unrewarded milestone and refuses duplicates', async () => {
    const { app } = startService({ rewardEveryN: 2, discountPercent: 10 });
    await request(app).post('/admin/coupons/generate').expect(409);
    await placeOrders(app, 2);
    const first = await request(app).post('/admin/coupons/generate').expect(201);
    expect(first.body.data.milestoneOrderCount).toBe(2);
    expect(first.body.data.percentOff).toBe(10);
    const duplicate = await request(app).post('/admin/coupons/generate');
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('COUPON_ALREADY_GENERATED');
    await placeOrders(app, 2);
    const second = await request(app).post('/admin/coupons/generate').expect(201);
    expect(second.body.data.milestoneOrderCount).toBe(4);
  });

  it('allows only one concurrent redemption of a coupon', async () => {
    const { app } = startService({ rewardEveryN: 1, discountPercent: 10 });
    await placeOrders(app, 1);
    const coupon = (await request(app).post('/admin/coupons/generate').expect(201)).body.data;
    const cartA = await createCartWithItem(app, 'p-keyboard', 1);
    const cartB = await createCartWithItem(app, 'p-mouse', 1);

    const results = await Promise.all([
      request(app)
        .post(`/carts/${cartA}/checkout`)
        .set('Idempotency-Key', 'coupon-race-A')
        .send({ couponCode: coupon.id }),
      request(app)
        .post(`/carts/${cartB}/checkout`)
        .set('Idempotency-Key', 'coupon-race-B')
        .send({ couponCode: coupon.id }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = results.find((r) => r.status === 201)!;
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.error.code).toBe('COUPON_ALREADY_REDEEMED');
    expect(winner.body.data.discount).not.toBe('0.00');
    expect(winner.body.data.couponId).toBe(coupon.id);

    const report = await request(app).get('/admin/report').expect(200);
    expect(report.body.data.coupons).toEqual({ generated: 1, available: 0, redeemed: 1 });
    expect(report.body.data.totalSuccessfullyPlacedOrders).toBe(2);
  });

  it('does not consume a coupon when checkout fails', async () => {
    const { app } = startService({ rewardEveryN: 1 });
    await placeOrders(app, 1);
    const coupon = (await request(app).post('/admin/coupons/generate').expect(201)).body.data;
    const emptyCart = (await request(app).post('/carts').expect(201)).body.data.id as string;
    const failed = await request(app)
      .post(`/carts/${emptyCart}/checkout`)
      .set('Idempotency-Key', 'empty-cart-0001')
      .send({ couponCode: coupon.id });
    expect(failed.status).toBe(400);
    expect(failed.body.error.code).toBe('EMPTY_CART');

    const cart = await createCartWithItem(app, 'p-cable', 1);
    const success = await request(app)
      .post(`/carts/${cart}/checkout`)
      .set('Idempotency-Key', 'coupon-later-0001')
      .send({ couponCode: coupon.id })
      .expect(201);
    expect(success.body.data.couponId).toBe(coupon.id);
  });

  it('applies a deterministic discount that cannot make net negative', async () => {
    const { app } = startService({ rewardEveryN: 1, discountPercent: 100 });
    await placeOrders(app, 1);
    const coupon = (await request(app).post('/admin/coupons/generate').expect(201)).body.data;
    const cartId = await createCartWithItem(app, 'p-cable', 1);
    const order = await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set('Idempotency-Key', 'full-discount-01')
      .send({ couponCode: coupon.id })
      .expect(201);
    expect(order.body.data.gross).toBe('4.99');
    expect(order.body.data.discount).toBe('4.99');
    expect(order.body.data.net).toBe('0.00');
  });

  it('rolls inventory and coupon back if payment fails', async () => {
    const db = createDatabase(':memory:');
    const { app, store } = createApp({
      db,
      config: { rewardEveryN: 1, discountPercent: 10 },
    });
    await placeOrders(app, 1);
    const coupon = (await request(app).post('/admin/coupons/generate').expect(201)).body.data;
    const failing = createApp({
      db,
      config: { rewardEveryN: 1, discountPercent: 10 },
      payment: new RejectPayment(),
    });
    const cartId = await createCartWithItem(failing.app, 'p-cable', 1);
    const response = await request(failing.app)
      .post(`/carts/${cartId}/checkout`)
      .set('Idempotency-Key', 'payment-fail-0001')
      .send({ couponCode: coupon.id });
    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe('PAYMENT_FAILED');
    expect(store.report().coupons.available).toBe(1);
    expect(store.report().totalSuccessfullyPlacedOrders).toBe(1);
    expect(store.getProduct('p-cable').availableInventory).toBe(99);
  });
});
