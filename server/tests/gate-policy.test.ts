import { describe, expect, it } from 'vitest';
import { applyGatePolicy } from '../src/kb/gate-policy.js';

const warningRules = [
  'body_contains_change_history', 'body_contains_source_metadata', 'total_too_large',
  'link_target_missing', 'link_anchor_missing', 'coverage_important_unresolved',
  'migration_unexplained_loss', 'evidence_budget_exceeded',
];

describe('publication gate policy', () => {
  it.each(warningRules)('%s is a warning only in standard mode', (rule) => {
    const issue = { code: 'original', rule, severity: 'blocking' as const };
    expect(applyGatePolicy([issue], { strict: true, version: 1 }).blocking).toEqual([issue]);
    expect(applyGatePolicy([issue], { strict: false, version: 1 }).warnings)
      .toEqual([{ ...issue, severity: 'warning', demotedFrom: 'blocking' }]);
  });
  it('drops unconfigured human review only in standard mode', () => {
    const issue = { code: 'human', rule: 'human_review_unconfigured', severity: 'warning' as const };
    expect(applyGatePolicy([issue], { strict: true, version: 1 }).warnings).toEqual([issue]);
    expect(applyGatePolicy([issue], { strict: false, version: 1 }).dropped).toBe(1);
  });
  it.each(['coverage_target_missing', 'kb_restatement_stale'])('%s demotes only proven historical issues', (rule) => {
    const issue = { code: 'original', rule, severity: 'blocking' as const };
    expect(applyGatePolicy([issue], { strict: false, version: 1 }).blocking).toEqual([issue]);
    expect(applyGatePolicy([issue], { strict: false, version: 1 }, () => true).blocking).toEqual([issue]);
    expect(applyGatePolicy([issue], { strict: false, version: 1 }, () => false).warnings[0]?.demotedFrom).toBe('blocking');
    expect(applyGatePolicy([issue], { strict: true, version: 1 }, () => false).blocking).toEqual([issue]);
  });
  it('keeps hard and unknown rules blocking, without upgrading existing warnings', () => {
    const issues = [{ code: 'evidence_budget_hard' }, { code: 'new_rule' }, { code: 'warning', severity: 'warning' as const }];
    const result = applyGatePolicy(issues, { strict: false, version: 1 }, () => false);
    expect(result.blocking.map((issue) => issue.code)).toEqual(['evidence_budget_hard', 'new_rule']);
    expect(result.warnings.map((issue) => issue.code)).toEqual(['warning']);
  });
});
