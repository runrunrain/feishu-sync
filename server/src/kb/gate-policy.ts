/** Publication issue policy. Unregistered rules fail closed; callers must supply
 * attribution only when they can prove an issue is outside the changed scope. */
export type GateAction = 'block' | 'warn' | 'drop';
export interface GatePolicy { strict: boolean; version: 1 }

const STANDARD: Readonly<Record<string, { action: GateAction; scopeDemotable?: true }>> = {
  body_contains_change_history: { action: 'warn' },
  body_contains_source_metadata: { action: 'warn' },
  total_too_large: { action: 'warn' },
  link_target_missing: { action: 'warn' },
  link_anchor_missing: { action: 'warn' },
  human_review_unconfigured: { action: 'drop' },
  coverage_important_unresolved: { action: 'warn' },
  coverage_target_missing: { action: 'block', scopeDemotable: true },
  migration_unexplained_loss: { action: 'warn' },
  evidence_budget_exceeded: { action: 'warn' },
  evidence_budget_hard: { action: 'block' },
  kb_restatement_stale: { action: 'block', scopeDemotable: true },
};

type Issue = { code: string; rule?: string; severity?: 'blocking' | 'warning'; demotedFrom?: 'blocking' };

export function applyGatePolicy<T extends Issue>(
  issues: T[], policy: GatePolicy, attributable?: (issue: T) => boolean,
): { blocking: T[]; warnings: T[]; dropped: number } {
  const blocking: T[] = [];
  const warnings: T[] = [];
  let dropped = 0;
  for (const issue of issues) {
    const rule = policy.strict ? undefined : STANDARD[issue.rule ?? issue.code];
    if (rule?.action === 'drop') { dropped++; continue; }
    const demote = rule?.action === 'warn'
      || (rule?.scopeDemotable === true && attributable !== undefined && !attributable(issue));
    if (issue.severity === 'warning') warnings.push(issue);
    else if (demote) warnings.push({ ...issue, severity: 'warning', demotedFrom: 'blocking' });
    else blocking.push(issue);
  }
  return { blocking, warnings, dropped };
}
