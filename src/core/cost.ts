import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PRICES_PATH } from './paths.ts';
import { ensureHome } from './store.ts';

export type Tier = 'tiny' | 'small' | 'medium' | 'large';

export interface ModelPrice {
  id: string;
  provider: string;
  in: number;
  out: number;
  tier: Tier;
}

const TIER_ORDER: Tier[] = ['tiny', 'small', 'medium', 'large'];

const DEFAULT_PRICES: ModelPrice[] = [
  { id: 'deepseek-chat', provider: 'deepseek', in: 0.27, out: 1.1, tier: 'small' },
  { id: 'deepseek-reasoner', provider: 'deepseek', in: 0.55, out: 2.19, tier: 'large' },
  { id: 'qwen3-1.7b', provider: 'local', in: 0, out: 0, tier: 'tiny' },
  { id: 'qwen3-32b', provider: 'alibaba', in: 0.1, out: 0.3, tier: 'medium' },
  { id: 'kimi-k2', provider: 'moonshot', in: 0.6, out: 2.5, tier: 'large' },
  { id: 'gemini-2.5-flash', provider: 'google', in: 0.3, out: 2.5, tier: 'medium' },
  { id: 'claude-haiku-4-5', provider: 'anthropic', in: 1.0, out: 5.0, tier: 'small' },
  { id: 'claude-sonnet-4-6', provider: 'anthropic', in: 3.0, out: 15.0, tier: 'large' },
  { id: 'gpt-4.1-mini', provider: 'openai', in: 0.4, out: 1.6, tier: 'small' },
  { id: 'gpt-4.1', provider: 'openai', in: 2.0, out: 8.0, tier: 'large' },
];

export function loadPrices(): ModelPrice[] {
  if (!existsSync(PRICES_PATH)) return DEFAULT_PRICES;
  try {
    const parsed = JSON.parse(readFileSync(PRICES_PATH, 'utf8')) as ModelPrice[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_PRICES;
  } catch {
    return DEFAULT_PRICES;
  }
}

export function savePrices(models: ModelPrice[]): void {
  ensureHome();
  writeFileSync(PRICES_PATH, JSON.stringify(models, null, 2) + '\n');
}

export function cost(model: ModelPrice, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * model.in + (outputTokens / 1_000_000) * model.out;
}

export function cheapestFor(tier: Tier, inputTokens = 0, outputTokens = 0): { model: ModelPrice; usd: number } {
  const minIndex = TIER_ORDER.indexOf(tier);
  const capable = loadPrices().filter((m) => TIER_ORDER.indexOf(m.tier) >= minIndex);
  const pool = capable.length > 0 ? capable : loadPrices();
  let best = pool[0];
  let bestCost = cost(best, inputTokens, outputTokens);
  for (const model of pool.slice(1)) {
    const c = cost(model, inputTokens, outputTokens);
    const cheaper = c < bestCost;
    const sameButLowerTier = c === bestCost && TIER_ORDER.indexOf(model.tier) < TIER_ORDER.indexOf(best.tier);
    if (cheaper || sameButLowerTier) {
      best = model;
      bestCost = c;
    }
  }
  return { model: best, usd: bestCost };
}

export function tierForTask(hint: string): Tier {
  const t = hint.toLowerCase();
  if (/rename|format|typo|summary|summar|label|comment|commit message|小/.test(t)) return 'tiny';
  if (/test|fix|bug|edit|refactor|small/.test(t)) return 'small';
  if (/feature|implement|build|module|api/.test(t)) return 'medium';
  if (/architect|design|debug hard|explain|research|plan|review/.test(t)) return 'large';
  return 'medium';
}
