export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
  stock INTEGER NOT NULL CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS carts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CHECKED_OUT')),
  order_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL UNIQUE REFERENCES carts(id),
  status TEXT NOT NULL CHECK (status = 'PLACED'),
  gross_paise INTEGER NOT NULL CHECK (gross_paise >= 0),
  discount_paise INTEGER NOT NULL CHECK (discount_paise >= 0),
  net_paise INTEGER NOT NULL CHECK (net_paise >= 0),
  coupon_id TEXT UNIQUE,
  payment_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CHECK (net_paise = gross_paise - discount_paise)
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  line_total_paise INTEGER NOT NULL CHECK (line_total_paise >= 0),
  PRIMARY KEY (order_id, product_id),
  CHECK (line_total_paise = unit_price_paise * quantity)
);

CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  milestone INTEGER NOT NULL UNIQUE CHECK (milestone > 0),
  percent_off INTEGER NOT NULL CHECK (percent_off >= 1 AND percent_off <= 100),
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE', 'REDEEMED')),
  redeemed_by_order_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  created_at TEXT NOT NULL
);
`;

export const SEED_PRODUCTS = [
  { id: 'p-laptop', name: 'Laptop Stand', unitPricePaise: 249900, stock: 8 },
  { id: 'p-mouse', name: 'Wireless Mouse', unitPricePaise: 129900, stock: 20 },
  { id: 'p-keyboard', name: 'Mechanical Keyboard', unitPricePaise: 459900, stock: 10 },
  { id: 'p-cable', name: 'USB-C Cable', unitPricePaise: 499, stock: 100 },
  { id: 'p-monitor', name: 'Portable Monitor', unitPricePaise: 1499900, stock: 2 },
] as const;
