import { describe, expect, it } from 'vitest';
import { fieldAppliesTo } from './applicability.ts';

describe('field applicability down to the sub-category', () => {
  it.each([
    ['92', 'SE11', true], ['92', 'XS52', true], ['92', 'XS51', false], ['92', 'XT73', true], ['92', 'XT71', false], ['92', 'XTD1', true], ['92', 'XTD2', false],
    ['93', 'XLA3', true], ['93', 'XLA1', false], ['93', 'XTE2', true], ['93', 'XS22', true], ['93', 'XS21', false],
    ['138', 'SE27', true], ['138', 'SE11', false], ['142', 'XS21', true], ['142', 'SE11', false], ['132', 'XT71', false], ['132', 'SE31', true],
    ['42', 'XS21', true], ['42', 'XLA1', false], ['33', 'XT71', false], ['33', 'XT73', true],
  ])('field %s for %s: %s', (id, cic, want) => expect(fieldAppliesTo(id, cic)).toBe(want));
});
