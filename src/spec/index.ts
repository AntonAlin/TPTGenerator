/**
 * Single entry point for the active TPT specification.
 * All app code must read field definitions from here, never hard-code them.
 */
import specJson from './tpt_spec.json';
import type { SpecField, TptSpec } from './types.ts';

export const spec = specJson as unknown as TptSpec;

const byId = new Map<string, SpecField>(spec.fields.map((f) => [f.id, f]));

/** Look up a field by its template id ("12", "8b", "1000"). Throws if the active spec lacks it. */
export function field(id: string): SpecField {
  const f = byId.get(id);
  if (!f) throw new Error(`Field ${id} is not defined in TPT ${spec.meta.version}.`);
  return f;
}

/** Like `field` but returns undefined when the active spec version has no such field. */
export function maybeField(id: string): SpecField | undefined {
  return byId.get(id);
}

export type { SpecField, TptSpec } from './types.ts';
