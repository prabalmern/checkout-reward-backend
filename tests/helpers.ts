import type { Express } from 'express';
import request from 'supertest';
import { loadConfig } from '../src/config';
import { createDatabase } from '../src/db/database';
import { createApp } from '../src/http/app';
import { AlwaysSucceedPayment } from '../src/payment';

export function startService(options: { rewardEveryN?: number; discountPercent?: number } = {}) {
  const db = createDatabase(':memory:');
  const config = {
    ...loadConfig({ REWARD_EVERY_N: String(options.rewardEveryN ?? 5), DISCOUNT_PERCENT: String(options.discountPercent ?? 10) }),
  };
  return createApp({ db, config, payment: new AlwaysSucceedPayment() });
}

export async function createCartWithItem(app: Express, productId = 'p-cable', quantity = 1) {
  const cartResponse = await request(app).post('/carts').expect(201);
  const cartId = cartResponse.body.data.id as string;
  await request(app).post(`/carts/${cartId}/items`).send({ productId, quantity }).expect(200);
  return cartId;
}
