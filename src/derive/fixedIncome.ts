/**
 * Fixed income analytics without market data: coupon schedule, accrued
 * interest, yield to maturity (numerical solver) and Macaulay / modified
 * duration, from coupon, maturity, frequency and a clean price in % of nominal.
 *
 * Conventions (all user-changeable and recorded with every result):
 * - Coupon dates are generated backwards from maturity in steps of 12/frequency months
 *   (end-of-month rule when the maturity is the last day of a month).
 * - Yield is compounded `frequency` times a year ("street convention"); the period
 *   fraction to the next coupon uses actual days (ICMA style) for every day count.
 * - The day count convention controls accrued interest.
 * Floating-rate notes and perpetuals are not handled: results are left empty.
 */

export type DayCount = 'ACT/ACT ICMA' | '30E/360' | 'ACT/360' | 'ACT/365F';
export const DAY_COUNTS: DayCount[] = ['ACT/ACT ICMA', '30E/360', 'ACT/360', 'ACT/365F'];
export type Frequency = 1 | 2 | 4 | 12;
export const FREQUENCIES: Frequency[] = [1, 2, 4, 12];

const DAY = 864e5;

const parse = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
};
const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const daysBetween = (a: string, b: string) => Math.round((toTime(b) - toTime(a)) / DAY);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Add months, clamping to month end; if `eom`, always land on the last day of the month. */
export function addMonths(date: string, months: number, eom = false): string {
  const { y, m, d } = parse(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const ld = lastDay(ny, nm);
  return iso(ny, nm, eom ? ld : Math.min(d, ld));
}

export interface Schedule {
  previous: string;
  next: string;
  /** Remaining coupon dates from `next` to maturity inclusive. */
  remaining: string[];
}

export function couponSchedule(maturity: string, frequency: Frequency, settlement: string): Schedule | undefined {
  if (!(settlement < maturity)) return undefined;
  const step = 12 / frequency;
  const { y, m, d } = parse(maturity);
  const eom = d === lastDay(y, m);
  const remaining: string[] = [maturity];
  let k = 1;
  let date = addMonths(maturity, -step, eom);
  while (date > settlement) {
    remaining.unshift(date);
    k++;
    date = addMonths(maturity, -step * k, eom);
    if (k > 12 * 200) return undefined;
  }
  return { previous: date, next: remaining[0], remaining };
}

function days30E360(a: string, b: string): number {
  const p = parse(a);
  const q = parse(b);
  const d1 = Math.min(p.d, 30);
  const d2 = Math.min(q.d, 30);
  return 360 * (q.y - p.y) + 30 * (q.m - p.m) + (d2 - d1);
}

/** Accrued interest per 100 nominal at settlement. */
export function accruedPer100(coupon: number, schedule: Schedule, settlement: string, frequency: Frequency, dc: DayCount): number {
  const { previous, next } = schedule;
  switch (dc) {
    case 'ACT/ACT ICMA':
      return (coupon / frequency) * (daysBetween(previous, settlement) / daysBetween(previous, next));
    case '30E/360':
      return (coupon * days30E360(previous, settlement)) / 360;
    case 'ACT/360':
      return (coupon * daysBetween(previous, settlement)) / 360;
    case 'ACT/365F':
      return (coupon * daysBetween(previous, settlement)) / 365;
  }
}

interface Flow {
  /** Time in coupon periods from settlement. */
  t: number;
  amount: number;
}

function cashFlows(coupon: number, schedule: Schedule, settlement: string, frequency: Frequency): Flow[] {
  const w = daysBetween(settlement, schedule.next) / daysBetween(schedule.previous, schedule.next);
  return schedule.remaining.map((_, k) => ({
    t: k + w,
    amount: coupon / frequency + (k === schedule.remaining.length - 1 ? 100 : 0),
  }));
}

function dirtyPrice(flows: Flow[], y: number, f: Frequency): number {
  return flows.reduce((s, cf) => s + cf.amount / Math.pow(1 + y / f, cf.t), 0);
}

/** Solve dirty(y) = target with Newton's method, falling back to bisection. Returns undefined if no root. */
export function solveYield(flows: Flow[], target: number, f: Frequency): number | undefined {
  let lo = -0.5 * f + 1e-6;
  let hi = 2;
  const g = (y: number) => dirtyPrice(flows, y, f) - target;
  if (g(lo) < 0 || g(hi) > 0) return undefined; // price decreases in y
  let y = 0.03;
  for (let i = 0; i < 100; i++) {
    const v = g(y);
    if (Math.abs(v) < 1e-10) return y;
    if (v > 0) lo = y;
    else hi = y;
    const deriv = flows.reduce((s, cf) => s - (cf.t / f) * cf.amount * Math.pow(1 + y / f, -cf.t - 1), 0);
    let next = y - v / deriv;
    if (!(next > lo && next < hi) || !Number.isFinite(next)) next = (lo + hi) / 2;
    if (Math.abs(next - y) < 1e-13) return next;
    y = next;
  }
  return Math.abs(g(y)) < 1e-6 ? y : undefined;
}

export interface BondInput {
  /** Annual coupon in % of nominal (e.g. 0.75). */
  coupon: number;
  maturity: string;
  settlement: string;
  /** Clean price in % of nominal. */
  cleanPrice?: number;
  frequency: Frequency;
  dayCount: DayCount;
}

export interface BondAnalytics {
  accruedPer100: number;
  previousCoupon: string;
  nextCoupon: string;
  /** Yield to maturity as a decimal (0.0312 = 3.12%). */
  yieldToMaturity?: number;
  macaulayDuration?: number;
  modifiedDuration?: number;
  assumptions: string;
}

export function bondAnalytics(b: BondInput): BondAnalytics | undefined {
  if (b.maturity === '9999-12-31') return undefined;
  const sched = couponSchedule(b.maturity, b.frequency, b.settlement);
  if (!sched) return undefined;
  const ai = accruedPer100(b.coupon, sched, b.settlement, b.frequency, b.dayCount);
  const assumptions = `${b.dayCount}, ${b.frequency} coupon(s)/year, coupon dates rolled back from maturity, settlement = ${b.settlement}, yield compounded ${b.frequency}×/year, bullet redemption at 100`;
  const out: BondAnalytics = { accruedPer100: ai, previousCoupon: sched.previous, nextCoupon: sched.next, assumptions };
  if (b.cleanPrice === undefined || !(b.cleanPrice > 0)) return out;
  const flows = cashFlows(b.coupon, sched, b.settlement, b.frequency);
  const y = solveYield(flows, b.cleanPrice + ai, b.frequency);
  if (y === undefined) return out;
  const p = dirtyPrice(flows, y, b.frequency);
  const mac = flows.reduce((s, cf) => s + (cf.t / b.frequency) * (cf.amount / Math.pow(1 + y / b.frequency, cf.t)), 0) / p;
  return { ...out, yieldToMaturity: y, macaulayDuration: mac, modifiedDuration: mac / (1 + y / b.frequency) };
}
