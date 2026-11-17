/** Offline investigation fixture. No LLM, Feishu, SQLite, or full build is invoked.
 * Run from server/: npx --no-install tsx scripts/investigate-newuser-build-block.ts
 * All writes are confined to a fresh OS temporary directory (printed below).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, LlmProviderConfig } from '../src/types/index.js';
import type { ResolvedRuntime } from '../src/agent/runtime-resolver.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-newuser-'));
process.env.FEISHU_SYNC_HOME = home;
const { ConfigManager } = await import('../src/modules/config-manager.js');
const { PiRuntimeResolver, resolveAppLlmModel } = await import('../src/agent/runtime-resolver.js');
const { KbBuildService } = await import('../src/kb/kb-build-service.js');
const { buildAppLlmRunConfig } = await import('../src/agent/provider-descriptor.js');
console.log(`TEMP_HOME=${home}`);
// Call the real production methods, without creating a service/pipeline or dependencies.
const roleHost = Object.create(KbBuildService.prototype) as {
  describeRoleModel: (c: Config, r: { modelPresetId: string; providerId?: string }, v: string) => unknown;
  resolveLeaderModels: (c: Config) => { models: unknown };
};
const runtime: ResolvedRuntime = {
  nodePath: process.execPath, nodeVersion: '22.19.0', piPackageRoot: home,
  piCliPath: path.join(home, 'fixture-cli.js'), piVersion: '1.4.0',
};
// Controlled runtime discovery is explicitly a fixture; model/config branches are real.
function resolverFixture(patch: Partial<ResolvedRuntime> = {}) {
  const resolver = new PiRuntimeResolver();
  resolver.resolveRuntime = async () => ({ ...runtime, ...patch });
  return resolver;
}
const manager = new ConfigManager(path.join(home, 'config.json'));
const fresh = await manager.load();
console.log('FRESH=' + JSON.stringify({ model: fresh.agent.model, roles: fresh.standardKb.buildRoles, vision: fresh.agent.vision?.enabled }));
const provider: LlmProviderConfig = {
  id: 'p1', name: 'Fixture', enabled: true, apiKey: 'fixture-not-a-real-key',
  protocol: 'openai-completions', openAiCompatBaseUrl: 'https://example.invalid/v1',
  defaultModelId: 'm1', models: [{ id: 'm1', name: 'Default', enabled: true, openAiModel: 'fixture-model' }],
};
function configFor(p: LlmProviderConfig = provider): Config {
  const c = structuredClone(fresh);
  c.llm.providers = [structuredClone(p)];
  delete c.llm.activeProviderId; delete c.llm.activeModelId;
  return c;
}
async function check(name: string, c: Config, expected: string, leaderOk = true) {
  const r = resolverFixture();
  const status = await r.checkReadiness({ agentConfig: c.agent, llmConfig: c.llm, runningProcesses: 0 });
  assert.equal(status.code, expected, name);
  const resolved = resolveAppLlmModel(c.llm, c.agent);
  const role = roleHost.describeRoleModel(c, c.standardKb.buildRoles!.writer, 'fixture');
  let leader = 'ok';
  try { roleHost.resolveLeaderModels(c); } catch (e) { leader = `${(e as { code?: string }).code}: ${(e as Error).message}`; }
  assert.equal(leader === 'ok', leaderOk, name);
  const descriptor = buildAppLlmRunConfig(c.llm, c.agent);
  console.log(JSON.stringify({ name, active: [c.llm.activeProviderId ?? null, c.llm.activeModelId ?? null], resolved: resolved?.openAiModel ?? null, role: Boolean(role), readiness: status.code, message: status.message, leader, descriptorModel: descriptor?.model, descriptorPresent: Boolean(descriptor?.providerJson) }));
}
await check('provider-only/default-set/active-unset', configFor(), 'ready');
const withoutDefault = structuredClone(provider); delete withoutDefault.defaultModelId;
await check('provider-only/default-unset/active-unset', configFor(withoutDefault), 'ready');
const active = configFor(); active.llm.activeProviderId = 'p1'; active.llm.activeModelId = 'm1';
await check('ModelDefaultsSettings payload', active, 'ready');
const override = configFor(); override.agent.model.providerId = 'p1'; override.agent.model.modelId = 'm1';
await check('AgentSettingsCard override', override, 'ready');
// Exercise actual ConfigManager save/load normalization with the provider editor's payload.
await manager.updateConfig({ llm: { providers: [provider] } as Config['llm'] });
const normalized = await manager.load();
assert.equal(normalized.llm.activeProviderId, 'p1'); assert.equal(normalized.llm.activeModelId, 'm1');
assert.equal(normalized.standardKb.buildRoles!.writer.modelPresetId, '');
assert.equal(normalized.standardKb.buildRoles!.reviewer.modelPresetId, '');
await check('persisted-provider-only payload', normalized, 'ready');
await manager.updateConfig({ llm: { providers: [withoutDefault] } as Config['llm'], standardKb: { buildRoles: { writer: {}, reviewer: {} } } as Config['standardKb'] });
const normalizedMissing = await manager.load();
assert.equal(normalizedMissing.llm.providers![0].defaultModelId, 'm1');
assert.equal(normalizedMissing.standardKb.buildRoles!.writer.modelPresetId, '');
console.log('NORMALIZED_ROLES=' + JSON.stringify(normalizedMissing.standardKb.buildRoles));
await check('persisted-no-default-and-empty-roles', normalizedMissing, 'ready');
for (const protocol of ['openai-responses', 'anthropic-messages'] as const) {
  await check(protocol, configFor({ ...provider, protocol }), 'ready', false);
}
await check('missing-key', configFor({ ...provider, apiKey: '' }), 'model_auth_missing', false);
await check('invalid-baseUrl', configFor({ ...provider, openAiCompatBaseUrl: '' }), 'model_unconfigured', false);
const stale = configFor(); stale.agent.model.providerId = 'deleted-provider';
await check('stale-agent-override', stale, 'model_unconfigured', false);
const staleRole = configFor(); staleRole.standardKb.buildRoles!.writer.modelPresetId = 'deleted-preset';
await check('stale-role-override', staleRole, 'ready', false);
await check('provider-disabled', configFor({ ...provider, enabled: false }), 'model_unconfigured', false);
await check('model-disabled', configFor({ ...provider, models: [{ ...provider.models[0], enabled: false }] }), 'model_unconfigured', false);
const input = { agentConfig: active.agent, llmConfig: active.llm, runningProcesses: 0 };
for (const [name, patch, expected] of [
  ['node_missing', { nodePath: null }, 'node_missing'],
  ['node_old', { nodeVersion: '22.18.0' }, 'node_too_old'],
  ['pi_missing', { piCliPath: null, piVersion: null }, 'pi_missing'],
  ['pi_old', { piVersion: '1.3.0' }, 'pi_version_unsupported'],
] as const) {
  const status = await resolverFixture(patch).checkReadiness(input);
  assert.equal(status.code, expected); console.log(JSON.stringify({ name, code: status.code, message: status.message }));
}
for (const [name, result, expected] of [
  ['probe-empty', { ok: true, available: [] }, 'model_auth_missing'],
  ['probe-spawn-failed', { ok: false, available: [], stderr: 'fixture spawn failure' }, 'pi_spawn_failed'],
  ['probe-model-present', { ok: true, available: ['feishu-sync-llm/fixture-model'] }, 'ready'],
] as const) {
  const r = resolverFixture();
  const status = await r.checkReadiness(input, async () => ({ ...result, available: [...result.available] }));
  assert.equal(status.code, expected);
  // Same resolver, same config: build does NOT pass modelProbe and has a separate cache key.
  const buildStatus = await r.checkReadiness(input);
  assert.equal(buildStatus.code, 'ready');
  console.log(JSON.stringify({ name, code: status.code, message: status.message, subsequentBuildReadiness: buildStatus.code }));
}
// Real local discovery (no modelProbe, no network, no auth file read in app-llm mode).
const local = await new PiRuntimeResolver().checkReadiness(input);
console.log(JSON.stringify({ name: 'real-local-runtime', code: local.code, message: local.message, runtime: local.runtime }));
console.log('PASS: all offline assertions; temp fixture retained for inspection; no full build started.');
