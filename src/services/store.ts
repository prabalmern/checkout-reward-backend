import { createHash, randomUUID } from 'node:crypto';
import type { AppConfig } from '../config';
import { withImmediateTransaction, type SqliteDb } from '../db/database';
import { AppError, Errors } from '../errors';
import { lineTotal, netAfterDiscount, percentOffPaise } from '../money';
import type { PaymentGateway } from '../payment';
import {
  presentCart,
  presentCoupon,
  presentOrder,
  presentProduct,
  type CartItemJoin,
  type CartRow,
  type CouponRow,
  type OrderItemRow,
  type OrderRow,
  type ProductRow,
} from '../presenters';

export type CheckoutInput = {
  cartId: string;
  couponCode?: string;
  idempotencyKey: string;
};

export class Store {
  constructor(
    private readonly db: SqliteDb,
    private readonly config: AppConfig,
    private readonly payment: PaymentGateway,
  ) {}

  listProducts() {
    const rows = this.db.prepare('SELECT id, name, unit_price_paise, stock FROM products ORDER BY id').all() as ProductRow[];
    return rows.map(presentProduct);
  }

  getProduct(productId: string) {
    return presentProduct(this.requireProduct(productId));
  }

  createCart() {
    const id = randomUUID();
    const createdAt = isoNow();
    this.db.prepare("INSERT INTO carts (id, status, created_at) VALUES (?, 'OPEN', ?)").run(id, createdAt);
    return this.getCart(id);
  }

  getCart(cartId: string) {
    const cart = this.requireCart(cartId);
    const items = this.loadCartItems(cartId);
    return presentCart(cart, items);
  }

  addItem(cartId: string, productId: string, quantity: number) {
    return withImmediateTransaction(this.db, () => {
      this.requireOpenCart(cartId);
      const product = this.requireProduct(productId);
      const existing = this.db
        .prepare('SELECT quantity FROM cart_items WHERE cart_id = ? AND product_id = ?')
        .get(cartId, productId) as { quantity: number } | undefined;
      const nextQuantity = (existing?.quantity ?? 0) + quantity;
      this.assertStock(product, nextQuantity);
      this.db
        .prepare(
          `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)
           ON CONFLICT(cart_id, product_id) DO UPDATE SET quantity = excluded.quantity`,
        )
        .run(cartId, productId, nextQuantity);
      return this.getCart(cartId);
    });
  }

  updateItem(cartId: string, productId: string, quantity: number) {
    return withImmediateTransaction(this.db, () => {
      this.requireOpenCart(cartId);
      const product = this.requireProduct(productId);
      const existing = this.db
        .prepare('SELECT quantity FROM cart_items WHERE cart_id = ? AND product_id = ?')
        .get(cartId, productId);
      if (!existing) {
        throw Errors.notFound('CART_ITEM_NOT_FOUND', 'Product is not in this cart', { cartId, productId });
      }
      this.assertStock(product, quantity);
      this.db
        .prepare('UPDATE cart_items SET quantity = ? WHERE cart_id = ? AND product_id = ?')
        .run(quantity, cartId, productId);
      return this.getCart(cartId);
    });
  }

  removeItem(cartId: string, productId: string) {
    return withImmediateTransaction(this.db, () => {
      this.requireOpenCart(cartId);
      const result = this.db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?').run(cartId, productId);
      if (result.changes === 0) {
        throw Errors.notFound('CART_ITEM_NOT_FOUND', 'Product is not in this cart', { cartId, productId });
      }
      return this.getCart(cartId);
    });
  }

  checkout(input: CheckoutInput) {
    this.assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = checkoutFingerprint(input.cartId, input.couponCode);
    return withImmediateTransaction(this.db, () => {
      const replay = this.replayIfIdempotent(input.idempotencyKey, fingerprint);
      if (replay) return replay;

      const cart = this.requireOpenCart(input.cartId);
      const cartItems = this.loadCartItems(cart.id);
      if (cartItems.length === 0) {
        throw Errors.badRequest('EMPTY_CART', 'Cannot check out an empty cart', { cartId: cart.id });
      }

      const snapshotItems = cartItems.map((item) => {
        if (item.quantity > item.stock) {
          throw Errors.conflict('INSUFFICIENT_STOCK', `Insufficient stock for '${item.name}'`, {
            productId: item.product_id,
            available: item.stock,
            requested: item.quantity,
          });
        }
        const unitPricePaise = item.unit_price_paise;
        const quantity = item.quantity;
        return {
          productId: item.product_id,
          productName: item.name,
          unitPricePaise,
          quantity,
          lineTotalPaise: lineTotal(unitPricePaise, quantity),
        };
      });

      const grossPaise = snapshotItems.reduce((sum, item) => sum + item.lineTotalPaise, 0);
      let discountPaise = 0;
      let coupon: CouponRow | undefined;
      if (input.couponCode) {
        coupon = this.requireAvailableCoupon(input.couponCode);
        discountPaise = percentOffPaise(grossPaise, coupon.percent_off);
      }
      const netPaise = netAfterDiscount(grossPaise, discountPaise);
      const orderId = `order_${randomUUID()}`;
      const createdAt = isoNow();

      for (const item of snapshotItems) {
        const result = this.db
          .prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?')
          .run(item.quantity, item.productId, item.quantity);
        if (result.changes === 0) {
          throw Errors.conflict('INSUFFICIENT_STOCK', `Insufficient stock for '${item.productName}'`, {
            productId: item.productId,
            requested: item.quantity,
          });
        }
      }

      if (coupon) {
        const result = this.db
          .prepare(
            `UPDATE coupons
             SET status = 'REDEEMED', redeemed_by_order_id = ?
             WHERE id = ? AND status = 'AVAILABLE'`,
          )
          .run(orderId, coupon.id);
        if (result.changes === 0) {
          throw Errors.conflict('COUPON_ALREADY_REDEEMED', 'Coupon has already been redeemed', {
            couponId: coupon.id,
          });
        }
      }

      let payment;
      try {
        payment = this.payment.charge({ orderId, amountPaise: netPaise });
      } catch (error) {
        throw new AppError(402, 'PAYMENT_FAILED', 'Payment was declined', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }

      this.db
        .prepare(
          `INSERT INTO orders (
            id, cart_id, status, gross_paise, discount_paise, net_paise,
            coupon_id, payment_id, idempotency_key, created_at
          ) VALUES (?, ?, 'PLACED', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          orderId,
          cart.id,
          grossPaise,
          discountPaise,
          netPaise,
          coupon?.id ?? null,
          payment.paymentId,
          input.idempotencyKey,
          createdAt,
        );

      const insertItem = this.db.prepare(
        `INSERT INTO order_items (
          order_id, product_id, product_name, unit_price_paise, quantity, line_total_paise
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const item of snapshotItems) {
        insertItem.run(
          orderId,
          item.productId,
          item.productName,
          item.unitPricePaise,
          item.quantity,
          item.lineTotalPaise,
        );
      }

      this.db
        .prepare("UPDATE carts SET status = 'CHECKED_OUT', order_id = ? WHERE id = ? AND status = 'OPEN'")
        .run(orderId, cart.id);

      this.db
        .prepare('INSERT INTO idempotency_keys (key, request_fingerprint, order_id, created_at) VALUES (?, ?, ?, ?)')
        .run(input.idempotencyKey, fingerprint, orderId, createdAt);

      return this.getOrder(orderId);
    });
  }

  getOrder(orderId: string) {
    const order = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined;
    if (!order) {
      throw Errors.notFound('ORDER_NOT_FOUND', `Order '${orderId}' was not found`);
    }
    const items = this.db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY product_id').all(orderId) as OrderItemRow[];
    return presentOrder(order, items);
  }

  generateCoupon() {
    return withImmediateTransaction(this.db, () => {
      const { n } = { n: this.config.rewardEveryN };
      const placed = (this.db.prepare('SELECT COUNT(*) AS c FROM orders').get() as { c: number }).c;
      if (placed < n) {
        throw Errors.conflict('MILESTONE_NOT_REACHED', `Coupon milestone requires ${n} placed orders`, {
          placedOrders: placed,
          milestone: n,
        });
      }
      const maxEligible = Math.floor(placed / n) * n;
      const generated = this.db.prepare('SELECT milestone FROM coupons').all() as Array<{ milestone: number }>;
      const generatedSet = new Set(generated.map((row) => row.milestone));
      let eligible: number | undefined;
      for (let milestone = n; milestone <= maxEligible; milestone += n) {
        if (!generatedSet.has(milestone)) {
          eligible = milestone;
          break;
        }
      }
      if (eligible === undefined) {
        throw Errors.conflict('COUPON_ALREADY_GENERATED', 'No unrewarded order milestone is currently eligible', {
          placedOrders: placed,
          milestone: n,
        });
      }
      const coupon: CouponRow = {
        id: `coupon_${randomUUID()}`,
        milestone: eligible,
        percent_off: this.config.discountPercent,
        status: 'AVAILABLE',
        redeemed_by_order_id: null,
        created_at: isoNow(),
      };
      try {
        this.db
          .prepare(
            `INSERT INTO coupons (id, milestone, percent_off, status, created_at)
             VALUES (?, ?, ?, 'AVAILABLE', ?)`,
          )
          .run(coupon.id, coupon.milestone, coupon.percent_off, coupon.created_at);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw Errors.conflict('COUPON_ALREADY_GENERATED', 'No unrewarded order milestone is currently eligible', {
            placedOrders: placed,
            milestone: n,
          });
        }
        throw error;
      }
      return presentCoupon(coupon);
    });
  }

  report() {
    const purchased = this.db
      .prepare(
        `SELECT product_id AS productId, product_name AS productName, SUM(quantity) AS quantity
         FROM order_items
         GROUP BY product_id, product_name
         ORDER BY product_id`,
      )
      .all() as Array<{ productId: string; productName: string; quantity: number }>;

    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) AS totalSuccessfullyPlacedOrders,
           COALESCE(SUM(gross_paise), 0) AS grossPaise,
           COALESCE(SUM(discount_paise), 0) AS discountPaise,
           COALESCE(SUM(net_paise), 0) AS netPaise
         FROM orders`,
      )
      .get() as {
      totalSuccessfullyPlacedOrders: number;
      grossPaise: number;
      discountPaise: number;
      netPaise: number;
    };

    const couponCounts = this.db
      .prepare(
        `SELECT
           COUNT(*) AS generated,
           SUM(CASE WHEN status = 'AVAILABLE' THEN 1 ELSE 0 END) AS available,
           SUM(CASE WHEN status = 'REDEEMED' THEN 1 ELSE 0 END) AS redeemed
         FROM coupons`,
      )
      .get() as { generated: number; available: number | null; redeemed: number | null };

    return {
      totalSuccessfullyPlacedOrders: totals.totalSuccessfullyPlacedOrders,
      purchasedQuantityByProduct: purchased.map((row) => ({
        productId: row.productId,
        productName: row.productName,
        quantity: Number(row.quantity),
      })),
      grossRevenue: formatFromPaise(totals.grossPaise),
      grossRevenuePaise: Number(totals.grossPaise),
      totalDiscountsGranted: formatFromPaise(totals.discountPaise),
      totalDiscountsGrantedPaise: Number(totals.discountPaise),
      netRevenue: formatFromPaise(totals.netPaise),
      netRevenuePaise: Number(totals.netPaise),
      coupons: {
        generated: Number(couponCounts.generated),
        available: Number(couponCounts.available ?? 0),
        redeemed: Number(couponCounts.redeemed ?? 0),
      },
    };
  }

  /** Test helper: mutate catalog price/stock after a cart was built. */
  debugUpdateProduct(productId: string, patch: { unitPricePaise?: number; stock?: number }) {
    const product = this.requireProduct(productId);
    const price = patch.unitPricePaise ?? product.unit_price_paise;
    const stock = patch.stock ?? product.stock;
    this.db.prepare('UPDATE products SET unit_price_paise = ?, stock = ? WHERE id = ?').run(price, stock, productId);
  }

  private replayIfIdempotent(key: string, fingerprint: string) {
    const existing = this.db
      .prepare('SELECT request_fingerprint, order_id FROM idempotency_keys WHERE key = ?')
      .get(key) as { request_fingerprint: string; order_id: string } | undefined;
    if (!existing) return undefined;
    if (existing.request_fingerprint !== fingerprint) {
      throw Errors.conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'This idempotency key was already used for a different checkout request',
      );
    }
    return this.getOrder(existing.order_id);
  }

  private requireCart(cartId: string): CartRow {
    const cart = this.db.prepare('SELECT * FROM carts WHERE id = ?').get(cartId) as CartRow | undefined;
    if (!cart) throw Errors.notFound('CART_NOT_FOUND', `Cart '${cartId}' was not found`);
    return cart;
  }

  private requireOpenCart(cartId: string): CartRow {
    const cart = this.requireCart(cartId);
    if (cart.status !== 'OPEN') {
      throw Errors.conflict('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out', {
        orderId: cart.order_id,
      });
    }
    return cart;
  }

  private requireProduct(productId: string): ProductRow {
    const product = this.db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as ProductRow | undefined;
    if (!product) throw Errors.notFound('PRODUCT_NOT_FOUND', `Product '${productId}' was not found`);
    return product;
  }

  private requireAvailableCoupon(couponId: string): CouponRow {
    const coupon = this.db.prepare('SELECT * FROM coupons WHERE id = ?').get(couponId) as CouponRow | undefined;
    if (!coupon) throw Errors.notFound('COUPON_NOT_FOUND', 'Coupon was not found');
    if (coupon.status !== 'AVAILABLE') {
      throw Errors.conflict('COUPON_ALREADY_REDEEMED', 'Coupon has already been redeemed', {
        couponId,
        redeemedByOrderId: coupon.redeemed_by_order_id,
      });
    }
    return coupon;
  }

  private loadCartItems(cartId: string): CartItemJoin[] {
    return this.db
      .prepare(
        `SELECT
           ci.product_id, p.name, ci.quantity, p.unit_price_paise, p.stock
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
         WHERE ci.cart_id = ?
         ORDER BY ci.product_id`,
      )
      .all(cartId) as CartItemJoin[];
  }

  private assertStock(product: ProductRow, requested: number) {
    if (requested > product.stock) {
      throw Errors.conflict('INSUFFICIENT_STOCK', 'Requested quantity exceeds current stock', {
        productId: product.id,
        available: product.stock,
        requested,
      });
    }
  }

  private assertIdempotencyKey(key: string) {
    if (key.trim().length < 8 || key.length > 200) {
      throw Errors.badRequest(
        'IDEMPOTENCY_KEY_REQUIRED',
        'Provide an Idempotency-Key header between 8 and 200 characters',
      );
    }
  }
}

function isoNow() {
  return new Date().toISOString();
}

function checkoutFingerprint(cartId: string, couponCode?: string) {
  return createHash('sha256').update(JSON.stringify({ cartId, couponCode: couponCode ?? null })).digest('hex');
}

function isUniqueViolation(error: unknown) {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function formatFromPaise(paise: number) {
  return (Number(paise) / 100).toFixed(2);
}

export { AppError };
