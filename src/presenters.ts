import { formatMoney } from './money';

export type ProductRow = {
  id: string;
  name: string;
  unit_price_paise: number;
  stock: number;
};

export type CartRow = {
  id: string;
  status: 'OPEN' | 'CHECKED_OUT';
  order_id: string | null;
  created_at: string;
};

export type CartItemJoin = {
  product_id: string;
  name: string;
  quantity: number;
  unit_price_paise: number;
  stock: number;
};

export type OrderRow = {
  id: string;
  cart_id: string;
  status: 'PLACED';
  gross_paise: number;
  discount_paise: number;
  net_paise: number;
  coupon_id: string | null;
  payment_id: string;
  idempotency_key: string;
  created_at: string;
};

export type OrderItemRow = {
  product_id: string;
  product_name: string;
  unit_price_paise: number;
  quantity: number;
  line_total_paise: number;
};

export type CouponRow = {
  id: string;
  milestone: number;
  percent_off: number;
  status: 'AVAILABLE' | 'REDEEMED';
  redeemed_by_order_id: string | null;
  created_at: string;
};

export function presentProduct(row: ProductRow) {
  return {
    id: row.id,
    name: row.name,
    unitPrice: formatMoney(row.unit_price_paise),
    unitPricePaise: row.unit_price_paise,
    availableInventory: row.stock,
  };
}

export function presentCart(cart: CartRow, items: CartItemJoin[]) {
  const presentedItems = items.map((item) => ({
    productId: item.product_id,
    productName: item.name,
    quantity: item.quantity,
    unitPrice: formatMoney(item.unit_price_paise),
    unitPricePaise: item.unit_price_paise,
    lineTotal: formatMoney(item.unit_price_paise * item.quantity),
    lineTotalPaise: item.unit_price_paise * item.quantity,
    availableInventory: item.stock,
    exceedsInventory: item.quantity > item.stock,
  }));
  const subtotalPaise = presentedItems.reduce((sum, item) => sum + item.lineTotalPaise, 0);
  return {
    id: cart.id,
    status: cart.status,
    orderId: cart.order_id,
    createdAt: cart.created_at,
    items: presentedItems,
    subtotal: formatMoney(subtotalPaise),
    subtotalPaise,
    pricedUsing: 'current_catalog' as const,
  };
}

export function presentOrder(order: OrderRow, items: OrderItemRow[]) {
  return {
    id: order.id,
    cartId: order.cart_id,
    status: order.status,
    couponId: order.coupon_id,
    paymentId: order.payment_id,
    createdAt: order.created_at,
    items: items.map((item) => ({
      productId: item.product_id,
      productName: item.product_name,
      quantity: item.quantity,
      unitPrice: formatMoney(item.unit_price_paise),
      unitPricePaise: item.unit_price_paise,
      lineTotal: formatMoney(item.line_total_paise),
      lineTotalPaise: item.line_total_paise,
    })),
    gross: formatMoney(order.gross_paise),
    grossPaise: order.gross_paise,
    discount: formatMoney(order.discount_paise),
    discountPaise: order.discount_paise,
    net: formatMoney(order.net_paise),
    netPaise: order.net_paise,
  };
}

export function presentCoupon(row: CouponRow) {
  return {
    id: row.id,
    milestoneOrderCount: row.milestone,
    percentOff: row.percent_off,
    status: row.status,
    redeemedByOrderId: row.redeemed_by_order_id,
    createdAt: row.created_at,
  };
}
