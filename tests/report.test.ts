import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createCartWithItem, startService } from './helpers';

describe('administrator reporting', () => {
  it('is read-only and reconciles with committed orders and coupons', async () => {
    const { app } = startService({ rewardEveryN: 1, discountPercent: 10 });
    const cartId = await createCartWithItem(app, 'p-cable', 2);
    await request(app).post(`/carts/${cartId}/checkout`).set('Idempotency-Key', 'report-order-001').send({}).expect(201);
    const coupon = (await request(app).post('/admin/coupons/generate').expect(201)).body.data;
    const discountedCart = await createCartWithItem(app, 'p-cable', 1);
    await request(app)
      .post(`/carts/${discountedCart}/checkout`)
      .set('Idempotency-Key', 'report-order-002')
      .send({ couponCode: coupon.id })
      .expect(201);

    const a = await request(app).get('/admin/report').expect(200);
    const b = await request(app).get('/admin/report').expect(200);
    expect(a.body).toEqual(b.body);
    expect(a.body.data.totalSuccessfullyPlacedOrders).toBe(2);
    expect(a.body.data.purchasedQuantityByProduct).toEqual([
      { productId: 'p-cable', productName: 'USB-C Cable', quantity: 3 },
    ]);
    expect(a.body.data.grossRevenue).toBe('14.97');
    expect(a.body.data.totalDiscountsGranted).toBe('0.49');
    expect(a.body.data.netRevenue).toBe('14.48');
    expect(a.body.data.coupons).toEqual({ generated: 1, available: 0, redeemed: 1 });
  });
});
