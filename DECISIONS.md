# Decisions

Approximate time spent: **5 hours**.

## Invariants

1. Product stock is never negative and never oversold. The only decrement is `UPDATE products SET stock = stock - qty WHERE id = ? AND stock >= qty` inside a `BEGIN IMMEDIATE` transaction. Zero rows updated aborts the transaction.
2. A cart is checked out at most once. `carts.status` is `OPEN` or `CHECKED_OUT`; `orders.cart_id` is unique; a second checkout with a new idempotency key returns `CART_ALREADY_CHECKED_OUT`.
3. An identical checkout retry does not create a second order or decrement stock twice. `idempotency_keys.key` is unique. Same key and same fingerprint returns the original order. Same key and a different fingerprint returns `IDEMPOTENCY_KEY_REUSED`.
4. A coupon is generated at most once per milestone (`coupons.milestone` unique) and redeemed at most once (`status` plus `redeemed_by_order_id` unique, updated only `WHERE status = 'AVAILABLE'`).
5. A coupon is not consumed by a checkout that fails. Coupon and stock updates happen in the same transaction as the order insert. Any error rolls the transaction back.
6. An order stores product id, name, unit price, quantity, and line totals at checkout time. Later catalog edits do not rewrite history.
7. Money is integer paise. Discount is `floor(gross * percent / 100)`. `net = gross - discount`, constrained in SQL to be non-negative and equal to that difference.
8. The admin report is a read of committed orders and coupons. It does not write.

## Ambiguities and chosen semantics

**Price after add, before checkout.** Carts store id + quantity. `GET /carts/:id` uses live catalog prices (`pricedUsing: current_catalog`). Checkout charges the price at commit time and snapshots it onto the order. If the merchant changes price, the customer pays the current price. This matches typical storefronts more closely than freezing a quote without an expiry.

**Availability after add, before checkout.** Adding an item is rejected if it exceeds *current* stock (fast feedback). Stock is not reserved for open carts. Checkout re-checks and is the only reservation. If inventory disappears, checkout returns `INSUFFICIENT_STOCK` and the cart remains `OPEN`.

**Coupon identity.** The coupon `id` is the redeemable code (`coupon_<uuid>`). One coupon per checkout. Percent off is the configured `x` at generation time, stored on the coupon so later config changes do not alter issued coupons.

**Milestone meaning.** With `n = 5`, successful orders 5, 10, 15, … each unlock one coupon. Generation is **admin-triggered**, not automatic at checkout. If the store has 12 orders and no coupons, the admin can generate the coupon for milestone 5, then the coupon for milestone 10, and must wait until order 15 for the next. Missed admin generations do not skip; they queue.

**Who can use a coupon.** Any checkout may supply any `AVAILABLE` coupon. Coupons are not bound to a customer (there is no customer model).

**Failed payment.** The payment port is invoked after stock and coupon updates in the same SQLite transaction. If `charge` throws, the transaction rolls back, so the coupon stays available and stock is restored. The API returns `402 PAYMENT_FAILED`.

**Idempotency HTTP status.** Replays return **201** with the original order, not 200. The client asked to create a checkout; the resource exists as a result of that logical request.

**Cart line add.** `POST /items` adds to an existing line rather than replacing it. Replacement is `PUT`.

## Decision: SQLite transactions instead of an in-memory mutex

**Context:** Overlapping checkouts must not oversell inventory or double-redeem a coupon. The previous codebase serialized the entire store behind one async mutex.

**Options considered:** (1) Global mutex over Maps. (2) Fine-grained in-memory locks per product and coupon. (3) SQLite with `BEGIN IMMEDIATE`, conditional updates, and unique constraints.

**Choice:** (3), using Node’s built-in `node:sqlite` (`DatabaseSync`) so there is no native addon to compile on Windows.

**Why:** Invariants belong in the data layer, where they can be named, tested, and later moved to Postgres. A process-wide mutex hides races that appear the moment a second instance exists. Fine-grained locks are easy to get wrong (deadlock order, forgotten keys). SQLite’s write lock plus `WHERE stock >= qty` encodes the rule twice: isolation and a predicate.

**Consequences:** One writer at a time per database file, which is enough for the timebox and for concurrent HTTP tests. Multiple app instances sharing one file would still serialize; multiple instances with separate memory databases would not. See scale section.

## Decision: Checkout is one atomic transaction including payment

**Context:** Coupon must not be lost if checkout fails after reservation. Payment is fake.

**Options considered:** (1) Treat checkout as payment success with no port. (2) Two-phase: reserve, charge, commit/compensate. (3) Charge inside the same DB transaction; rollback on payment failure.

**Choice:** A `PaymentGateway` port, default `AlwaysSucceedPayment`, invoked inside the write transaction after conditional stock and coupon updates.

**Why:** The assignment does not require a processor. A port documents the seam. Rolling back the local transaction on charge failure preserves coupon and inventory invariants without a compensation saga. A real card charge must **not** sit inside a database transaction (latency, timeouts, capture vs authorize). The next design would authorize outside, then commit local state, then capture, with an outbox for capture/refund.

**Consequences:** Tests can inject `RejectPayment` and assert rollback. Production card flows are deferred.

## Decision: Required Idempotency-Key on checkout

**Context:** Clients retry when they time out. Cart-id uniqueness prevents a second order on the same cart, but a client that creates a new cart after a lost response could still double-charge. The assignment calls out retries on the same checkout request.

**Options considered:** (1) Cart-id only. (2) Optional idempotency key. (3) Required key with fingerprint of cart + coupon.

**Choice:** (3). Replays must match `{ cartId, couponCode }`.

**Why:** Cart-id uniqueness is necessary but not the retry protocol. Stripe-style keys are the usual API for “I did not see the 201”. Making the header required avoids a silent non-idempotent default.

**Consequences:** Clients must send a stable key. Lost keys mean the client should `GET` the cart (it will be `CHECKED_OUT` with `orderId`) rather than invent a new key.

## Decision: Live cart pricing, snapshot at order time

**Context:** Catalog price and stock can change while a cart is open.

**Options considered:** (1) Snapshot price into the cart line on add. (2) Live price until checkout, snapshot on the order. (3) Explicit quote resource with TTL.

**Choice:** (2). Cart `GET` also returns `exceedsInventory` when the live stock is below the line quantity.

**Why:** (1) surprises merchants who update prices and still have stale carts paying old amounts, unless you add quote expiry. (3) is the production version of (1) and was too large for the timebox. (2) is explicit in the payload (`pricedUsing`) and keeps order history immutable.

**Consequences:** A customer can see one subtotal, wait, and pay another. A quote-freeze API would be the first pricing change if this were a real store.

## Decision: Admin-triggered coupons, not automatic issuance

**Context:** “An administrator can request coupon generation” and “a coupon is generated only if the milestone has been reached and a coupon has not already been generated for that milestone.”

**Options considered:** (1) Create the coupon inside the Nth checkout. (2) Admin poll/generate. (3) Outbox event + worker.

**Choice:** (2), with `UNIQUE(milestone)` so two concurrent admin requests cannot both insert milestone 10.

**Why:** The requirement is an admin operation. Auto-issue on checkout mixes selling with rewards and makes checkout retries more subtle (would a replay also try to issue?). Admin generation is a separate, idempotent-enough conflict (`COUPON_ALREADY_GENERATED`).

**Consequences:** If the admin never calls generate, shoppers never see a coupon even after 100 orders. That matches the written requirement.

## Decision: Distinguishable error codes, not only HTTP status

**Context:** Clients must tell “out of stock” from “coupon already used” from “cart already checked out”.

**Options considered:** (1) HTTP status only. (2) RFC 7807 problem+json. (3) `{ error: { code, message, details } }` with stable `code` strings.

**Choice:** (3), with 409 for conflicts, 404 for missing entities, 400 for validation/empty cart/missing idempotency key, 402 for payment failure.

**Why:** Status 409 is overloaded; the `code` is the contract. RFC 7807 is better for a public API and was deferred to keep the payload small.

**Consequences:** Codes are listed in the README and should be treated as part of the API.

## Money and rounding

- Storage and arithmetic: integer paise (`249900` = ₹2499.00).
- Line total: `unit_price_paise * quantity` (exact integer).
- Discount: `Math.floor(gross_paise * percent_off / 100)`.
- Net: `gross - discount`, with SQL `CHECK (net_paise = gross_paise - discount_paise)` and `net_paise >= 0`.
- JSON includes both `net` (`"14.48"`) for humans and `netPaise` for machines so clients do not re-parse floats.
- 100% off is allowed in tests and yields `0.00`. Percents are integers 1–100; no stacking.

## Transaction, concurrency, and idempotency strategy

Write paths that can race (`addItem`, `updateItem`, `checkout`, `generateCoupon`) run in `BEGIN IMMEDIATE` so SQLite takes the reserved lock before reads that decide writes.

Checkout sequence inside the transaction:

1. Replay if the idempotency key exists (fingerprint must match).
2. Load an `OPEN` cart; reject empty.
3. Join cart lines to products; reject if `quantity > stock`.
4. Load coupon if present; reject if missing or not `AVAILABLE`. Compute totals in paise.
5. Decrement stock with `stock >= qty`.
6. Mark coupon `REDEEMED` with `status = 'AVAILABLE'`.
7. Charge payment; on failure throw `PAYMENT_FAILED` (rollback).
8. Insert order, order_items, mark cart `CHECKED_OUT`, insert idempotency row.
9. Commit.

SQLite `busy_timeout = 5000` lets overlapping HTTP requests wait for the write lock instead of failing immediately. The second checkout still observes committed stock/coupon state.

Idempotency records are written only after a successful order, so a failed checkout does not poison a key.

## Error model

| Code | HTTP | When |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Zod: types, extra fields, quantity bounds |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Missing/short/long header |
| `EMPTY_CART` | 400 | Checkout with no lines |
| `PAYMENT_FAILED` | 402 | Payment port threw |
| `PRODUCT_NOT_FOUND` / `CART_NOT_FOUND` / `ORDER_NOT_FOUND` / `CART_ITEM_NOT_FOUND` / `COUPON_NOT_FOUND` | 404 | |
| `ROUTE_NOT_FOUND` | 404 | Unknown path |
| `INSUFFICIENT_STOCK` | 409 | Cart mutation or checkout |
| `CART_ALREADY_CHECKED_OUT` | 409 | |
| `COUPON_ALREADY_REDEEMED` | 409 | Sequential or concurrent |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same key, different body |
| `MILESTONE_NOT_REACHED` / `COUPON_ALREADY_GENERATED` | 409 | Admin generate |
| `INTERNAL_ERROR` | 500 | Unexpected |

## Implemented vs deferred

Implemented: catalog seed, carts, live pricing, checkout snapshots, integer money, idempotent checkout, conditional inventory, coupon generate/redeem, payment port with rollback, admin report, concurrent tests, OpenAPI + HTTP examples.

Intentionally deferred:

- Authentication and authorization (admin routes are labeled only).
- Customer accounts, coupon ownership, coupon expiry, minimum-basket rules, SKU-specific coupons, stacking.
- Stock reservation while a cart is open (checkout-time allocation only).
- Price quotes with TTL.
- Durable payment authorize/capture, webhooks, refunds, tax, shipping.
- Pagination, product admin CRUD, cart expiry, observability beyond `console.error`.
- Postgres, replicas, and horizontal scale (see below).
- RFC 7807, rate limits, OpenTelemetry.

Incomplete relative to a production store, not relative to the assignment timebox: no frontend; no load test beyond Vitest `Promise.all`.

## Multiple instances and production scale

Today: one Node process, one SQLite file (or `:memory:` in tests). `BEGIN IMMEDIATE` serializes writers on that file.

What would change:

1. **Postgres** (or similar) as the source of truth. Replace SQLite conditional updates with `SELECT ... FOR UPDATE` on product and coupon rows, or keep `UPDATE ... WHERE stock >= $qty RETURNING`. Unique constraints stay identical.
2. **Do not use process memory for inventory.** Two instances with in-memory Maps would oversell immediately. That is why this rewrite does not treat Maps as the system of record.
3. **Idempotency table** remains globally unique. All instances share it.
4. **Coupon generation** stays an `INSERT` with `UNIQUE(milestone)`; conflicts map to `COUPON_ALREADY_GENERATED`.
5. **Payments** move to an outbox: commit `order_pending_capture`, worker captures, compensating refund if capture fails after commit.
6. **Read models** for the report can be snapshots refreshed from orders; the assignment’s report is a cheap `SUM` and can stay live until order volume hurts.
7. SQLite is fine for a single-node demo and this evaluation. It is the wrong default once you need multiple writers across machines.

## How AI tools were used

I used Cursor Grok as the implementation assistant for this rewrite.

I asked it to delete the previous in-memory mutex service and replace it with a design that can survive overlapping requests. It produced a first pass that still resembled CRUD-around-Maps. I redirected it to put invariants in SQL (`CHECK`, unique milestones, `UPDATE ... WHERE stock >= ?`, coupon update only when `AVAILABLE`) and to charge payment *after* those updates so a throw rolls back coupon and stock.

I also rejected auto-issuing coupons inside checkout (the model mixed admin rewards with the sell path) and rejected snapshotting price onto the cart line without documenting it as a quote. Those calls are easy for a model to “helpfully” invent.

I treated generated tests as a risk list, not as proof: I kept competing checkout, competing coupon, retry, payment rollback, and report reconciliation, and dropped tests that only walked the happy path twice.

## If given another two hours

1. Replace `node:sqlite` with Postgres in Docker and re-run the same concurrency tests against `FOR UPDATE` (prove the SQL, not the SQLite write lock).
2. Add an outbox + failing-payment-after-commit scenario, which is the real payment hole.
3. Cart TTL and an explicit quote/expiry if live pricing is unacceptable.
4. Structured logs with `cartId`, `orderId`, `idempotencyKey` on every conflict.
5. Property test: for any interleaving of checkouts of `p-monitor` (stock 2), final stock ≥ 0 and sum of sold quantities ≤ 2.
