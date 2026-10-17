import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createCartWithItem, startService } from './helpers';

describe('carts and catalog', () => {
  it('rejects unknown products and non-positive quantities', async () => {
    const { app } = startService();
    const cartId = (await request(app).post('/carts').expect(201)).body.data.id as string;

    const missing = await request(app).post(`/carts/${cartId}/items`).send({ productId: 'nope', quantity: 1 });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('PRODUCT_NOT_FOUND');

    const invalid = await request(app).post(`/carts/${cartId}/items`).send({ productId: 'p-cable', quantity: 0 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('does not let a cart hold more than currently available stock', async () => {
    const { app } = startService();
    const cartId = (await request(app).post('/carts').expect(201)).body.data.id as string;
    const response = await request(app).post(`/carts/${cartId}/items`).send({ productId: 'p-monitor', quantity: 3 });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('prices the cart with live catalog values and snapshots price at checkout', async () => {
    const { app, store } = startService();
    const cartId = await createCartWithItem(app, 'p-cable', 2);
    const before = await request(app).get(`/carts/${cartId}`).expect(200);
    expect(before.body.data.subtotal).toBe('9.98');
    expect(before.body.data.pricedUsing).toBe('current_catalog');

    store.debugUpdateProduct('p-cable', { unitPricePaise: 10000 });
    const after = await request(app).get(`/carts/${cartId}`).expect(200);
    expect(after.body.data.subtotal).toBe('200.00');

    const order = await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set('Idempotency-Key', 'price-snapshot-01')
      .send({})
      .expect(201);
    expect(order.body.data.net).toBe('200.00');
    expect(order.body.data.items[0].unitPrice).toBe('100.00');

    store.debugUpdateProduct('p-cable', { unitPricePaise: 1 });
    const persisted = await request(app).get(`/orders/${order.body.data.id}`).expect(200);
    expect(persisted.body.data.net).toBe('200.00');
  });

  it('cannot check out the same cart twice with a different idempotency key', async () => {
    const { app } = startService();
    const cartId = await createCartWithItem(app);
    await request(app).post(`/carts/${cartId}/checkout`).set('Idempotency-Key', 'first-checkout').send({}).expect(201);
    const second = await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set('Idempotency-Key', 'second-checkout')
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CART_ALREADY_CHECKED_OUT');
  });
});
