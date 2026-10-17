# Checkout and Rewards Service

Backend for an ecommerce checkout flow with inventory, idempotent checkout, and milestone discount coupons.

The service is a single Node.js process backed by SQLite. Correctness under retries and overlapping writes is enforced with `BEGIN IMMEDIATE` transactions, conditional `UPDATE ... WHERE` statements, and unique constraints — not with a global mutex around all application state.

Approximate time spent: **5 hours**.

## Requirements

- Node.js 22.13 or later (`node:sqlite`)
- npm

## Setup

```bash
cd checkout-rewards
npm install
npm test
npm run dev
```

The API listens on `http://localhost:3000`. Data is stored in `data/store.sqlite`.

Configuration:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `data/store.sqlite` | SQLite file, or `:memory:` |
| `REWARD_EVERY_N` | `5` | Every *n*th successful order unlocks one coupon (`n`) |
| `DISCOUNT_PERCENT` | `10` | Coupon percent off (`x`) |

There are no private services or credentials.

## Seed catalog

| ID | Name | Unit price | Stock |
| --- | --- | --- | --- |
| `p-laptop` | Laptop Stand | 2499.00 | 8 |
| `p-mouse` | Wireless Mouse | 1299.00 | 20 |
| `p-keyboard` | Mechanical Keyboard | 4599.00 | 10 |
| `p-cable` | USB-C Cable | 4.99 (499 paise) | 100 |
| `p-monitor` | Portable Monitor | 14999.00 | 2 (limited) |

Prices are stored as integer paise. Responses also include decimal strings.

## HTTP API

All successful payloads are `{ "data": ... }`. Errors are `{ "error": { "code", "message", "details?" } }`.

Administrative operations (no auth implemented): `POST /admin/coupons/generate`, `GET /admin/report`.

### Catalog

| Method | Path | Status | Notes |
| --- | --- | --- | --- |
| `GET` | `/health` | 200 | Liveness |
| `GET` | `/products` | 200 | Seeded catalog |
| `GET` | `/products/:productId` | 200 / 404 `PRODUCT_NOT_FOUND` | |

### Carts

| Method | Path | Body | Status | Notes |
| --- | --- | --- | --- | --- |
| `POST` | `/carts` | — | 201 | Empty open cart |
| `GET` | `/carts/:cartId` | — | 200 / 404 `CART_NOT_FOUND` | Live catalog prices and `subtotal` |
| `POST` | `/carts/:cartId/items` | `{ productId, quantity }` | 200 | Adds to existing line |
| `PUT` | `/carts/:cartId/items/:productId` | `{ quantity }` | 200 | Replaces quantity |
| `DELETE` | `/carts/:cartId/items/:productId` | — | 200 | |

Cart mutation errors: `VALIDATION_ERROR` 400, `PRODUCT_NOT_FOUND` 404, `CART_ITEM_NOT_FOUND` 404, `INSUFFICIENT_STOCK` 409, `CART_ALREADY_CHECKED_OUT` 409.

Carts store product id and quantity only. `GET` prices with the **current** catalog. Checkout snapshots name, unit price, and line totals onto the order.

### Checkout and orders

`POST /carts/:cartId/checkout`

Headers: `Idempotency-Key` (required, 8–200 characters)

Body: `{ "couponCode"?: string }`

| Status | Code |
| --- | --- |
| 201 | Order placed (retries with the same key and body return the same order with 201) |
| 400 | `IDEMPOTENCY_KEY_REQUIRED`, `EMPTY_CART`, `VALIDATION_ERROR` |
| 402 | `PAYMENT_FAILED` (inventory and coupon rolled back) |
| 404 | `CART_NOT_FOUND`, `COUPON_NOT_FOUND` |
| 409 | `CART_ALREADY_CHECKED_OUT`, `INSUFFICIENT_STOCK`, `COUPON_ALREADY_REDEEMED`, `IDEMPOTENCY_KEY_REUSED` |

`GET /orders/:orderId` → 200 or 404 `ORDER_NOT_FOUND`.

### Administration

`POST /admin/coupons/generate` → 201 coupon, or 409 `MILESTONE_NOT_REACHED` / `COUPON_ALREADY_GENERATED`.

`GET /admin/report` → 200, read-only summary of quantities, gross/discount/net revenue, coupon counts, and placed-order count.

## Example

```bash
CART=$(curl -s -X POST http://localhost:3000/carts | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).data.id))")
curl -s -X POST http://localhost:3000/carts/$CART/items -H "Content-Type: application/json" -d "{\"productId\":\"p-cable\",\"quantity\":2}"
curl -s -X POST http://localhost:3000/carts/$CART/checkout -H "Content-Type: application/json" -H "Idempotency-Key: demo-checkout-0001" -d "{}"
curl -s http://localhost:3000/admin/report
```

A runnable collection is in `examples/api.http`. OpenAPI (`openapi.yaml`) documents every path, request body, success envelope, error envelope, and schema field returned by the service.

### Error codes

| HTTP | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Body failed schema (strict JSON) |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Missing/short/long `Idempotency-Key` |
| 400 | `EMPTY_CART` | Checkout with no lines |
| 402 | `PAYMENT_FAILED` | Fake payment declined; cart, stock, coupon unchanged |
| 404 | `PRODUCT_NOT_FOUND` | Unknown product |
| 404 | `CART_NOT_FOUND` | Unknown cart |
| 404 | `CART_ITEM_NOT_FOUND` | Product not on this cart |
| 404 | `ORDER_NOT_FOUND` | Unknown order |
| 404 | `COUPON_NOT_FOUND` | Unknown coupon id |
| 409 | `INSUFFICIENT_STOCK` | Requested qty exceeds available inventory |
| 409 | `CART_ALREADY_CHECKED_OUT` | Cart already produced an order |
| 409 | `COUPON_ALREADY_REDEEMED` | Coupon used (or lost a concurrent race) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different cart/coupon |
| 409 | `MILESTONE_NOT_REACHED` | Admin generate before enough orders |
| 409 | `COUPON_ALREADY_GENERATED` | Milestone already rewarded |
| 404 | `ROUTE_NOT_FOUND` | Unknown path |
| 500 | `INTERNAL_ERROR` | Unexpected failure |

## Tests

```bash
npm test
```

Tests cover retries, competing inventory, competing coupon redemption, failed checkout leaving coupons available, payment failure rollback, price snapshotting, and report reconciliation.

A small React demo of this API is in [`../web`](../web). Frontend is optional; the assignment is evaluated on backend invariants.

## Design notes

See [DECISIONS.md](./DECISIONS.md) for invariants, coupon semantics, concurrency, money, and what was deferred.
