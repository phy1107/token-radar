// Token Radar, model radar-3.
//
// One snapshot in, one ranked board out. The board is the 40 watchlist
// protocols plus every other pre-token protocol below the watchlist floor
// that is not an exchange and not a versioned pool, by TVL. Live-token
// protocols are never ranked: they are shown apart, at their market cap.
//
// Implied value is built only from the snapshot's own numbers:
//
//   multiple   = the category's median market-cap / TVL among the
//                snapshot's live-token protocols (at least 4 of them),
//                else that median shrunk toward the global median,
//                weight live_n / (live_n + 4), so a category with one
//                live comp counts it for a fifth and a category with
//                none takes the global median; clamped to 0.08..0.60.
//                It is computed at run time from the snapshot, never
//                written in by hand.
//   growth     = 1 + 0.55 * tanh(clamp(change_7d, -70, 300) / 60)
//                A seven-day print is a noisy week, so it is dampened:
//                a +4448% week and a +60% week end up close, and a
//                falling week costs at most about half the value.
//   maturity   = 0.75 + 0.25 * (1 - exp(-age_days / 540))
//                Age is days since DefiLlama first listed the protocol.
//                It rises fast at first and then flattens: a protocol
//                that has run two years with no token is worth more
//                than one listed last month, but a fifth year adds
//                almost nothing. Unknown age counts as 365 days.
//   discount   = 0.5 when the protocol is a wrapped, staked or
//                bridged product of a token that already trades
//                (its category, or a wrapped / staked / staking word
//                in its name, or an exchange name at the start),
//                else 1. Its token, if any, would be someone else's.
//   implied    = round(tvl_usd * multiple * growth * maturity * discount)
//
// No protocol name is ever special-cased: the same function scores
// every row, and every input to it is a field of the snapshot.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelConstants {
  multiple_floor: number;
  multiple_cap: number;
  multiple_min_live: number;
  /** Pseudo-observations of the global median a thin category is shrunk by. */
  multiple_prior: number;
  growth_weight: number;
  growth_scale: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  product_discount: number;
}

export const MODEL: ModelConstants = {
  multiple_floor: 0.08,
  multiple_cap: 0.6,
  multiple_min_live: 4,
  multiple_prior: 4,
  growth_weight: 0.55,
  growth_scale: 60,
  growth_floor: -70,
  growth_cap: 300,
  maturity_floor: 0.75,
  maturity_range: 0.25,
  maturity_days: 540,
  unknown_age_days: 365,
  product_discount: 0.5,
};

export const MODEL_VERSION = 'radar-3';

/** How many early (below-floor) rows the board carries at most. */
export const EARLY_ROWS = 200;

/** How many live-token protocols the Live token view carries. */
export const LIVE_ROWS = 24;

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    product_discount: number;
    age_days: number | null;
    multiple_live_n: number;
  };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  watchlist: boolean;
  multiple: number;
  multiple_live_n: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  product_discount: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  multiples: Record<string, CategoryMultiple>;
  global_multiple: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Days from `listedAt` to `asOf`, or null when either date is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether the snapshot records any token for this protocol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether this protocol is a wrapped, staked or bridged product of a token that already trades. */
export function isProductOfLiveToken(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  return EXCHANGES.some((e) => p.name.startsWith(e));
}

/** Whether the board may rank this protocol: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** One category's value multiple, with the evidence behind it. */
export interface CategoryMultiple {
  multiple: number;
  /** Live-token protocols in this category with a usable market-cap / TVL. */
  live_n: number;
  /** The category's own median market-cap / TVL, or null when it has none. */
  raw_median: number | null;
}

export interface Multiples {
  byCategory: Record<string, CategoryMultiple>;
  global: number;
}

/**
 * The value multiple for every category, computed from the snapshot's
 * live-token protocols. A category with enough live protocols (at least
 * multiple_min_live) takes its own median market-cap / TVL, clamped.
 * A thinner category does not have its own evidence thrown away for the
 * global median, and a single wild comp does not set the board either:
 * its clamped median is shrunk toward the global median, weight
 * live_n / (live_n + multiple_prior), so one live comp counts for a
 * fifth of the answer and three count for under half. A category with
 * no live comp at all takes the global median. Both are clamped, so one
 * wild outlier cannot set the multiple.
 */
export function categoryMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): Multiples {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    if (p.category !== null) {
      const list = byCategory.get(p.category) ?? [];
      list.push(ratio);
      byCategory.set(p.category, list);
    }
  }
  const global = all.length > 0 ? clamp(median(all), model.multiple_floor, model.multiple_cap) : 0.25;
  const out: Record<string, CategoryMultiple> = {};
  for (const [category, ratios] of byCategory) {
    const raw = median(ratios);
    const clamped = clamp(raw, model.multiple_floor, model.multiple_cap);
    if (ratios.length >= model.multiple_min_live) {
      out[category] = { multiple: round4(clamped), live_n: ratios.length, raw_median: round4(raw) };
    } else {
      const w = ratios.length / (ratios.length + model.multiple_prior);
      out[category] = {
        multiple: round4(clamp(w * clamped + (1 - w) * global, model.multiple_floor, model.multiple_cap)),
        live_n: ratios.length,
        raw_median: round4(raw),
      };
    }
  }
  return { byCategory: out, global };
}

export function multipleFor(p: SnapshotProtocol, multiples: Multiples): number {
  if (p.category !== null && multiples.byCategory[p.category] !== undefined) return multiples.byCategory[p.category]!.multiple;
  return multiples.global;
}

/** How many live-token comps stand behind a protocol's multiple, 0 when it is the global median alone. */
export function multipleLiveN(p: SnapshotProtocol, multiples: Multiples): number {
  if (p.category !== null && multiples.byCategory[p.category] !== undefined) return multiples.byCategory[p.category]!.live_n;
  return 0;
}

/** The multipliers and implied value one protocol gets. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  multiples: Multiples,
  model: ModelConstants = MODEL,
): { implied: number; multiple: number; growthPct: number; growthMult: number; maturityMult: number; discount: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  // Rounded first: the dashboard recomputes from the rounded multiple
  // board.json carries, so both must agree to the dollar.
  const multiple = round4(multipleFor(protocol, multiples));
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = clamp(rawGrowth, model.growth_floor, model.growth_cap);
  const growthMult = 1 + model.growth_weight * Math.tanh(growthPct / model.growth_scale);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + model.maturity_range * (1 - Math.exp(-Math.max(ageForModel, 0) / model.maturity_days));
  const discount = isProductOfLiveToken(protocol) ? model.product_discount : 1;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult * discount));
  return { implied, multiple, growthPct, growthMult, maturityMult, discount, age };
}

function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The board: watchlist first as a floor, then the early radar below it, ranked by implied value. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const multiples = categoryMultiples(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, multiples, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    watchlist: snapshot.watchlist.includes(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      multiple: round4(s.multiple),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      product_discount: s.discount,
      age_days: s.age,
      multiple_live_n: multipleLiveN(s.p, multiples),
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** One farm step as a single string: action, then its cost and time. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * One category's farm playbook: the main action, a second action that
 * shows a different side of the protocol, and a diligence check that
 * only makes sense for that kind of protocol. `{name}` is the protocol,
 * `{chain}` its first chain, `{capital}` the suggested capital in
 * dollars and `{small}` a fifth of it. The table is matched on the
 * snapshot's own category string, most specific first, so a new
 * category falls through to the generic playbook instead of breaking.
 */
interface Playbook {
  keys: string[];
  action: string;
  second: string;
  check: string;
}

const PLAYBOOKS: Playbook[] = [
  {
    keys: ['risk curator'],
    action: 'Allocate ${capital} into a {name} curator vault on {chain} and keep the shares.',
    second: 'Allocate ${small} to a second curator vault on {name} run by a different curator, so the wallet is spread across two managers.',
    check: "Compare the two curators' fees and 30-day vault returns on {name}'s own page, and move the smaller allocation to the better one.",
  },
  {
    keys: ['onchain capital allocator'],
    action: 'Deposit ${capital} into a {name} vault on {chain} and keep the shares.',
    second: 'Deposit ${small} into a second {name} vault with a different strategy, so the wallet shows more than one allocation.',
    check: "Read {name}'s strategy note for each vault and check its largest holding, so the allocation is one you understand.",
  },
  {
    keys: ['collateral markets'],
    action: 'Supply ${capital} of USDC as collateral to a {name} market on {chain} and keep the position open.',
    second: 'Borrow ${small} against the collateral on {name} and repay it within the week, so the account shows both sides of the market.',
    check: "Check the market's utilisation and borrow rate on {name}'s own page, and top the collateral up if utilisation is above 80%.",
  },
  {
    keys: ['cdp'],
    action: 'Lock ${capital} of collateral on {name} on {chain} and mint its stable asset, keeping the collateral ratio above 150%.',
    second: 'Repay ${small} of the minted stable asset on {name}, so the account shows both minting and repaying.',
    check: "Check the collateral ratio on {name}'s own page, and top the collateral up if the ratio falls toward liquidation.",
  },
  {
    keys: ['uncollateralized lending', 'lending'],
    action: 'Supply ${capital} of USDC to {name} on {chain} and keep the position open.',
    second: 'Borrow ${small} against the deposit on {name} and repay it within the week, so the account shows both sides of the market.',
    check: "Check the borrow rate and the collateral ratio on {name}'s own page, and repay early if the ratio falls toward liquidation.",
  },
  {
    keys: ['liquid restaking'],
    action: "Stake ${capital} of the chain's staking asset through {name} on {chain} and keep the receipt token.",
    second: 'Deposit the receipt token into a {name} restaking pool on {chain}, so the wallet shows the restaked leg too.',
    check: "Check the restaking yield and the withdrawal delay on {name}'s own page, and note the delay before counting on the funds.",
  },
  {
    keys: ['liquid staking'],
    action: "Stake ${capital} of the chain's staking asset through {name} on {chain} and keep the receipt token.",
    second: 'Provide ${small} of the receipt token as liquidity on {chain}, so the wallet shows the staked asset working twice.',
    check: "Check the staking APR and the receipt token's peg to the staked asset on {name}'s own page, and unstake if the peg slips.",
  },
  {
    keys: ['staking pool', 'restaking', 'staking'],
    action: "Stake ${capital} of the chain's staking asset through {name} and keep the receipt.",
    second: 'Claim the staking rewards on {name} once and restake them, so the account shows a full reward cycle.',
    check: "Check the reward rate and the unbonding period on {name}'s own page, and claim only from the link it publishes.",
  },
  {
    keys: ['leveraged farm'],
    action: "Open a leveraged farm of ${capital} on {name} on {chain} at its lowest leverage, and keep the position open.",
    second: 'Reduce the leverage on the {name} farm by a third after the first week, so the account shows active risk management.',
    check: "Check the liquidation price and the borrow rate on {name}'s own page every week, and close the farm if the rate doubles.",
  },
  {
    keys: ['liquidity manager'],
    action: "Deposit ${capital} into a {name} managed liquidity position on {chain} and keep the position open.",
    second: "Move the {name} position to the pool it marks as its highest-fee pool on {chain}, so the wallet shows a rebalance.",
    check: "Check the position's fee earnings and impermanent loss on {name}'s own page, and withdraw if fees stop covering the loss.",
  },
  {
    keys: ['yield aggregator'],
    action: "Deposit ${capital} into {name}'s highest-yield vault on {chain} and keep the shares.",
    second: 'Claim the vault yield on {name} once and redeposit it, so the account shows a full compounding cycle.',
    check: "Compare {name}'s vault APYs on its own page and move the deposit if another vault pays a third more for the same asset.",
  },
  {
    keys: ['indexes', 'index'],
    action: 'Buy ${capital} of the {name} index token on {chain} and hold it.',
    second: 'Check the index rebalance on {name} and add ${small} after a rebalance, so the wallet holds the new weights.',
    check: "Read {name}'s index composition on its own page, and sell if one asset grows past half the index.",
  },
  {
    keys: ['dex', 'yield'],
    action: "Provide ${capital} of liquidity to {name}'s main pool on {chain} and keep the position open.",
    second: "Swap ${small} through {name}'s main pool on {chain} once, so the wallet shows trading as well as liquidity.",
    check: "Check the pool's volume and fee earnings on {name}'s own page, and move the liquidity if volume falls for two weeks.",
  },
  {
    keys: ['farm'],
    action: "Deposit ${capital} of USDC into {name}'s main farm on {chain} and keep the position open.",
    second: 'Harvest the farm rewards on {name} once and redeposit them, so the account shows a full reward cycle.',
    check: "Check the farm's emission rate and reward token price on {name}'s own page, and exit if emissions are cut in half.",
  },
  {
    keys: ['canonical bridge', 'cross chain bridge', 'bridge'],
    action: 'Bridge ${capital} of USDC to {chain} through {name} and use the bridged funds in its app.',
    second: 'Send a second, smaller bridge of ${small} back through {name} the following week, so the route is used in both directions.',
    check: "Check the bridge time and fee on {name}'s own page before each crossing, and never bridge during a fee spike.",
  },
  {
    keys: ['basis trading'],
    action: "Deposit ${capital} into {name}'s basis vault on {chain} and keep the shares.",
    second: 'Check the funding rate the {name} vault earns and add ${small} when the rate is positive for a full week.',
    check: "Read {name}'s last funding-rate report on its own page, and withdraw if the rate stays negative for two weeks.",
  },
  {
    keys: ['perpetual', 'interest rate', 'derivative'],
    action: 'Deposit ${capital} of USDC as margin on {name} and open one small hedge.',
    second: 'Close the hedge on {name} and open a fresh one half its size, so the account shows repeated margin use.',
    check: "Check the funding rate and the liquidation price on {name}'s own page before every trade, and keep the hedge under a tenth of the margin.",
  },
  {
    keys: ['prediction'],
    action: 'Fund ${capital} and place one market position on {name}.',
    second: 'Close the first {name} position and open a second one on a different market, so the account shows more than one outcome.',
    check: "Check the market's resolution rules on {name}'s own page before betting, and never risk more than the ${capital} you funded.",
  },
  {
    keys: ['dual-token stablecoin', 'stablecoin wrapper', 'stable'],
    action: 'Mint or deposit ${capital} of the stable asset through {name} on {chain}.',
    second: 'Redeem ${small} of the stable asset back to USDC through {name}, so the account shows both minting and redeeming.',
    check: "Check the peg and the reserve attestation on {name}'s own page, and redeem the rest if the peg slips below $0.99.",
  },
  {
    keys: ['rwa'],
    action: "Mint ${capital} of the protocol's yield asset on {chain} and hold it.",
    second: "Check the underlying asset's custodian attestation on {name}'s own page and add ${small} only while it is current.",
    check: "Verify the custodian and the last audit date for {name}'s underlying assets, and exit if the attestation lapses.",
  },
  {
    keys: ['cedefi'],
    action: 'Deposit ${capital} into a {name} vault on {chain} and keep the shares.',
    second: 'Withdraw ${small} from the {name} vault and redeposit it a week later, so the account shows a full deposit cycle.',
    check: "Check the custodian and the proof of reserves on {name}'s own page, and withdraw if the proof is more than a month old.",
  },
  {
    keys: ['anchor btc', 'decentralized btc'],
    action: 'Mint ${capital} of the BTC-backed asset through {name} on {chain} and hold it.',
    second: 'Redeem ${small} of the BTC-backed asset through {name}, so the account shows both minting and redeeming.',
    check: "Check the BTC custody proof on {name}'s own page, and redeem if the backing falls below one bitcoin per token.",
  },
  {
    keys: ['chain'],
    action: 'Bridge ${capital} of USDC to the {name} chain and use one native app there.',
    second: 'Stake or delegate ${small} on the {name} chain, so the wallet shows native activity as well as the bridge.',
    check: "Check the {name} chain's block explorer to confirm each transaction landed, and note the finality time for the next one.",
  },
  {
    keys: ['governance'],
    action: 'Lock ${capital} in {name} governance on {chain} and vote on one live proposal.',
    second: 'Vote on a second {name} proposal the following week, so the account shows repeated governance activity.',
    check: "Read the proposal text on {name}'s own page before voting, and never delegate the vote to an address you do not know.",
  },
  {
    keys: ['payments', 'card'],
    action: 'Load ${capital} onto {name} on {chain} and spend a small amount through it.',
    second: 'Top {name} up by ${small} and spend it a week later, so the account shows repeated use.',
    check: "Check the fees and the settlement time on {name}'s own page, and keep no more than ${capital} loaded at once.",
  },
  {
    keys: ['insurance'],
    action: 'Buy ${capital} of cover from {name} on {chain} and keep the policy.',
    second: "Check the cover's expiry and claim window on {name}'s own page, and renew it before it lapses.",
    check: "Read what {name}'s cover excludes on its own page, and keep the policy only while the exclusion list is one you accept.",
  },
];

const GENERIC_PLAYBOOK: Playbook = {
  keys: [],
  action: 'Deposit ${capital} of USDC into {name} on {chain} and keep the position open.',
  second: 'Vote or interact with one governance or rewards action on {name} on {chain}, so the wallet is not only a deposit.',
  check: "Open {name}'s own page and check the position is counted, then read its latest update before adding more funds.",
};

/** The playbook for a protocol's own category, most specific match first. */
function playbookFor(p: SnapshotProtocol): Playbook {
  const c = (p.category ?? '').toLowerCase();
  for (const book of PLAYBOOKS) {
    if (book.keys.some((k) => c.includes(k))) return book;
  }
  return GENERIC_PLAYBOOK;
}

/** Fill a playbook template's placeholders for one protocol. */
function fill(template: string, p: SnapshotProtocol, capital: number, chain: string): string {
  const small = Math.max(10, Math.round(capital / 5));
  return template
    .replaceAll('{name}', p.name)
    .replaceAll('{chain}', chain)
    .replaceAll('{capital}', String(capital))
    .replaceAll('{small}', String(small));
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  return fill(playbookFor(p).action, p, capital, chain);
}

function secondActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  return fill(playbookFor(p).second, p, capital, chain);
}

function diligenceFor(p: SnapshotProtocol, capital: number, chain: string): string {
  return fill(playbookFor(p).check, p, capital, chain);
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a
 * time. The plan is derived from the protocol's own record (category,
 * chains, TVL, age), never from a hand-written list of names: the
 * playbook picks the main action, the second action and the diligence
 * check from the category, and the capital and the hold from the TVL
 * and the age. The dashboard renders these same steps from data.js,
 * so the page and board.json agree by construction.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const second = secondActionFor(p, capital, chain);
  const check = diligenceFor(p, capital, chain);
  const gas = capital >= 150 ? 8 : 4;
  return [
    { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: action, cost: `$${capital} of capital and about $${gas} of gas`, time: '15 minutes to set up' },
    { text: second, cost: `about $${gas} of gas, no new capital`, time: '10 minutes' },
    { text: check, cost: 'no fee to check', time: '15 minutes' },
    { text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`, cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Each week, open the protocol's own points or rewards page and check the position is counted; claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes a week' },
    { text: `Write the wallet, the dates and every transaction in a farm log, and plan the exit now: withdraw in two parts so a single failed transaction cannot strand the whole position.`, cost: 'nothing but the log', time: '5 minutes' },
  ];
}

/** The live-token protocols, by market cap, with their market multiple shown. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    watchlist: row.watchlist,
    multiple: row.model.multiple,
    multiple_live_n: row.model.multiple_live_n,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    product_discount: row.model.product_discount,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const multiples = categoryMultiples(snapshot, model);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    multiples: multiples.byCategory,
    global_multiple: multiples.global,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
