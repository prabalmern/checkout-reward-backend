export type AppConfig = {
  rewardEveryN: number;
  discountPercent: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rewardEveryN = parsePositiveInt(env.REWARD_EVERY_N ?? '5', 'REWARD_EVERY_N');
  const discountPercent = parseBoundedInt(env.DISCOUNT_PERCENT ?? '10', 'DISCOUNT_PERCENT', 1, 100);
  return { rewardEveryN, discountPercent };
}

function parsePositiveInt(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseBoundedInt(raw: string, name: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}
