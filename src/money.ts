/** Integer minor units. 1 rupee = 100 paise. Never use IEEE floats for arithmetic. */
export type Paise = number;

export function assertNonNegativePaise(value: number, label: string): Paise {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer number of paise`);
  }
  return value;
}

export function lineTotal(unitPricePaise: Paise, quantity: number): Paise {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('quantity must be a positive integer');
  }
  return unitPricePaise * quantity;
}

/**
 * Percent-off discount, rounded down to the nearest paise.
 * percentOff is an integer 1–100. Result is always in [0, gross].
 */
export function percentOffPaise(grossPaise: Paise, percentOff: number): Paise {
  if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) {
    throw new Error('percentOff must be an integer from 1 to 100');
  }
  return Math.floor((grossPaise * percentOff) / 100);
}

export function netAfterDiscount(grossPaise: Paise, discountPaise: Paise): Paise {
  const net = grossPaise - discountPaise;
  if (net < 0) {
    throw new Error('discount exceeded gross; this is a programming error');
  }
  return net;
}

export function formatMoney(paise: Paise): string {
  return (paise / 100).toFixed(2);
}
