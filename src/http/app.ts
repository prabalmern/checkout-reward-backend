import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { loadConfig, type AppConfig } from '../config';
import { createDatabase, type SqliteDb } from '../db/database';
import { AppError } from '../errors';
import { AlwaysSucceedPayment, type PaymentGateway } from '../payment';
import { Store } from '../services/store';

const addItemSchema = z
  .object({
    productId: z.string().min(1),
    quantity: z.number().int().positive().max(1000),
  })
  .strict();

const updateItemSchema = z
  .object({
    quantity: z.number().int().positive().max(1000),
  })
  .strict();

const checkoutSchema = z
  .object({
    couponCode: z.string().min(1).optional(),
  })
  .strict();

export type CreateAppOptions = {
  db?: SqliteDb;
  config?: AppConfig;
  payment?: PaymentGateway;
};

export function createApp(options: CreateAppOptions = {}) {
  const db = options.db ?? createDatabase();
  const config = options.config ?? loadConfig();
  const payment = options.payment ?? new AlwaysSucceedPayment();
  const store = new Store(db, config, payment);
  const app = express();

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/products', (_req, res) => {
    res.json({ data: store.listProducts() });
  });

  app.get('/products/:productId', (req, res) => {
    res.json({ data: store.getProduct(req.params.productId) });
  });

  app.post('/carts', (_req, res) => {
    res.status(201).json({ data: store.createCart() });
  });

  app.get('/carts/:cartId', (req, res) => {
    res.json({ data: store.getCart(req.params.cartId) });
  });

  app.post('/carts/:cartId/items', (req, res) => {
    const body = addItemSchema.parse(req.body);
    res.json({ data: store.addItem(req.params.cartId, body.productId, body.quantity) });
  });

  app.put('/carts/:cartId/items/:productId', (req, res) => {
    const body = updateItemSchema.parse(req.body);
    res.json({ data: store.updateItem(req.params.cartId, req.params.productId, body.quantity) });
  });

  app.delete('/carts/:cartId/items/:productId', (req, res) => {
    res.json({ data: store.removeItem(req.params.cartId, req.params.productId) });
  });

  app.post('/carts/:cartId/checkout', (req, res) => {
    const body = checkoutSchema.parse(req.body ?? {});
    const idempotencyKey = req.header('Idempotency-Key') ?? '';
    const order = store.checkout({
      cartId: req.params.cartId,
      couponCode: body.couponCode,
      idempotencyKey,
    });
    res.status(201).json({ data: order });
  });

  app.get('/orders/:orderId', (req, res) => {
    res.json({ data: store.getOrder(req.params.orderId) });
  });

  // Administrative: no auth in this assignment. Treat these as privileged.
  app.post('/admin/coupons/generate', (_req, res) => {
    res.status(201).json({ data: store.generateCoupon() });
  });

  app.get('/admin/report', (_req, res) => {
    res.json({ data: store.report() });
  });

  app.use((_req, _res, next) => {
    next(new AppError(404, 'ROUTE_NOT_FOUND', 'Route not found'));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details === undefined ? {} : { details: err.details }),
        },
      });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  });

  return { app, store, db };
}
