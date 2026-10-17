import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createCartWithItem, startService } from './helpers';

describe('checkout invariants', () => {
  it('replays an identical retry instead of creating a second order', async () => {
    const { app } = startService();
    const cartId = await createCartWithItem(app, 'p-cable', 1);
    const first = await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set('Idempotency-Key', 'retry-key-0001')
      .send({})
      .expect(201);
    const retry = await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set('Idempotency-Key', 'retry-key-0001')
      .send({})
      .expect(201);

    expect(retry.body.data.id).toBe(first.body.data.id);
    const product = await request(app).get('/products/p-cable').expect(200);
    expect(product.body.data.availableInventory).toBe(99);
    const report = await request(app).get('/admin/report').expect(200);
    expect(report.body.data.totalSuccessfullyPlacedOrders).toBe(1);
  });

  it('rejects idempotency key reuse with a different request', async () => {
    const { app } = startService();
    const cartId = await createCartWithItem(app);
    await request(app).post(`/carts/${cartId}/checkout`).set('Idempotency-Key', 'same-key-0001').send({}).expect(201);
    const otherCart = await createCartWithItem(app);
    const response = await request(app)
      .post(`/carts/${otherCart}/checkout`)
      .set('Idempotency-Key', 'same-key-0001')
      .send({});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('prevents overselling when concurrent carts compete for limited stock', async () => {
    const { app } = startService();
    const cartA = await createCartWithItem(app, 'p-monitor', 2);
    const cartB = await createCartWithItem(app, 'p-monitor', 1);

    const results = await Promise.all([
      request(app).post(`/carts/${cartA}/checkout`).set('Idempotency-Key', 'limited-stock-A').send({}),
      request(app).post(`/carts/${cartB}/checkout`).set('Idempotency-Key', 'limited-stock-B').send({}),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = results.find((r) => r.status === 201);
    const loser = results.find((r) => r.status === 409);
    expect(loser?.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(winner?.body.data.items[0].quantity).toBeGreaterThan(0);

    const product = await request(app).get('/products/p-monitor').expect(200);
    expect(product.body.data.availableInventory).toBe(0);
    const report = await request(app).get('/admin/report').expect(200);
    expect(report.body.data.totalSuccessfullyPlacedOrders).toBe(1);
    expect(report.body.data.purchasedQuantityByProduct[0].quantity).toBe(2);
  });

  it('fails checkout when inventory drops after the item was added, without creating an order', async () => {
    const { app, store } = startService();
    const cartId = await createCartWithItem(app, 'p-monitor', 2);
    store.debugUpdateProduct('p-monitor', { stock: 1 });
    const response = await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set('Idempotency-Key', 'stale-stock-0001')
      .send({});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
    const report = await request(app).get('/admin/report').expect(200);
    expect(report.body.data.totalSuccessfullyPlacedOrders).toBe(0);
  });
});
