/**
 * The classes of the row asset-class model: broad families, each standing for a group of the rule
 * engine's asset classes. The rules refine a family afterwards (a corporate bond into a covered or
 * subordinated one, a fund into a debt fund) from the name.
 */
import type { AssetClass } from './assetClass.ts';

export const ROW_CLASSES = [
  'equity', 'gov_bond', 'corporate_bond', 'treasury_bill', 'fund', 'cash', 'forward', 'future', 'call_option', 'put_option', 'swap',
] as const;
export type RowClass = (typeof ROW_CLASSES)[number];

/** The asset class a family stands for when the rules had nothing better. */
export const ROW_CLASS_ASSET: Record<RowClass, AssetClass> = {
  equity: 'equity',
  gov_bond: 'gov_bond',
  corporate_bond: 'corporate_bond',
  treasury_bill: 'treasury_bill',
  fund: 'fund_other',
  cash: 'cash',
  forward: 'forward',
  future: 'future',
  call_option: 'call_option',
  put_option: 'put_option',
  swap: 'swap',
};

export const ROW_CLASS_LABEL: Record<RowClass, string> = {
  equity: 'equity', gov_bond: 'government bond', corporate_bond: 'corporate bond', treasury_bill: 'treasury bill', fund: 'fund',
  cash: 'cash', forward: 'forward', future: 'future', call_option: 'call option', put_option: 'put option', swap: 'swap',
};

/** The family of one of the rule engine's asset classes (undefined for "other"). */
export function familyOf(c: AssetClass): RowClass | undefined {
  if (c.startsWith('equity')) return 'equity';
  if (c.startsWith('fund_')) return 'fund';
  switch (c) {
    case 'gov_bond': case 'supranational_bond': case 'regional_bond': case 'municipal_bond': case 'gov_covered_bond':
      return 'gov_bond';
    case 'treasury_bill':
      return 'treasury_bill';
    case 'corporate_bond': case 'convertible_bond': case 'commercial_paper': case 'money_market_instrument': case 'hybrid_bond':
    case 'covered_bond': case 'subordinated_bond': case 'structured_note': case 'collateralised_security':
      return 'corporate_bond';
    case 'cash': case 'deposit_short': case 'deposit_long':
      return 'cash';
    case 'future':
      return 'future';
    case 'call_option': case 'warrant':
      return 'call_option';
    case 'put_option':
      return 'put_option';
    case 'swap': case 'credit_derivative':
      return 'swap';
    case 'forward':
      return 'forward';
    default:
      return undefined;
  }
}
