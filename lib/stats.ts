// Token Radar, category summary.
//
// Groups the ranked board by category and summarises each group from
// the snapshot figures alone: how many of the snapshot's protocols in
// that category made the board, their combined TVL, the median
// seven-day change, their combined implied value, and the strongest
// protocol in the group. Nothing here names a protocol or a number
// in advance; every figure is computed at run time, so a new snapshot
// with different categories produces a different summary with no
// code change.

import type { RadarRow, SnapshotProtocol } from './model.ts';

/** One category's share of the board, as the dashboard renders it. */
export interface CategorySummary {
  category: string;
  protocols_on_board: number;
  protocols_in_snapshot: number;
  total_tvl_usd: number;
  median_change_7d: number | null;
  total_implied_value_usd: number;
  top_slug: string;
  top_name: string;
}

/** What a protocol with no recorded category is filed under. */
const NO_CATEGORY = 'Other';

/** The display label for a category value, or the fallback for none. */
function labelOf(category: string | null): string {
  return category === null || category === '' ? NO_CATEGORY : category;
}

/** The middle of a list of numbers, or null when the list is empty. */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle]!;
  return (ordered[middle - 1]! + ordered[middle]!) / 2;
}

interface Accumulator {
  count: number;
  totalTvl: number;
  totalImplied: number;
  changes: number[];
  best: RadarRow;
}

/**
 * Summarise the scored rows by category. The snapshot protocols are
 * counted per category too, so each line shows how much of its
 * category the board actually covers. Groups come out strongest
 * implied value first; ties break on the category name, so the
 * order is the same on every run.
 */
export function categorySummaries(rows: RadarRow[], protocols: SnapshotProtocol[]): CategorySummary[] {
  const inSnapshot = new Map<string, number>();
  for (const p of protocols) {
    const label = labelOf(p.category);
    inSnapshot.set(label, (inSnapshot.get(label) ?? 0) + 1);
  }

  const grouped = new Map<string, Accumulator>();
  for (const row of rows) {
    const label = labelOf(row.category);
    const acc = grouped.get(label);
    if (acc === undefined) {
      grouped.set(label, {
        count: 1,
        totalTvl: row.tvl_usd,
        totalImplied: row.implied_value_usd,
        changes: row.change_7d === null ? [] : [row.change_7d],
        best: row,
      });
      continue;
    }
    acc.count += 1;
    acc.totalTvl += row.tvl_usd;
    acc.totalImplied += row.implied_value_usd;
    if (row.change_7d !== null) acc.changes.push(row.change_7d);
    if (
      row.implied_value_usd > acc.best.implied_value_usd ||
      (row.implied_value_usd === acc.best.implied_value_usd && row.slug < acc.best.slug)
    ) {
      acc.best = row;
    }
  }

  const summaries: CategorySummary[] = [];
  for (const [category, acc] of grouped) {
    summaries.push({
      category,
      protocols_on_board: acc.count,
      protocols_in_snapshot: inSnapshot.get(category) ?? 0,
      total_tvl_usd: acc.totalTvl,
      median_change_7d: medianOf(acc.changes),
      total_implied_value_usd: acc.totalImplied,
      top_slug: acc.best.slug,
      top_name: acc.best.name,
    });
  }
  summaries.sort(
    (a, b) =>
      b.total_implied_value_usd - a.total_implied_value_usd ||
      (a.category < b.category ? -1 : a.category > b.category ? 1 : 0),
  );
  return summaries;
}
