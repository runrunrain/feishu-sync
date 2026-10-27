/** 应用上下文Pi扩展。用户可编辑文本，不能通过此入口注册工具或执行脚本。 */
import fs from 'node:fs';
import crypto from 'node:crypto';

export default function (pi) {
  const file = process.env.FEISHU_SYNC_AGENT_PLUGIN_SNAPSHOT;
  const expected = process.env.FEISHU_SYNC_AGENT_PLUGIN_REVISION;
  if (!file || !expected) throw new Error('Application plugin snapshot is missing');
  const raw = fs.readFileSync(file, 'utf8');
  if (crypto.createHash('sha256').update(raw).digest('hex') !== expected) throw new Error('Application plugin snapshot changed');
  const snapshot = JSON.parse(raw);
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.plugins)) throw new Error('Invalid application plugin snapshot');
  const sections = snapshot.plugins.filter((plugin) => plugin.enabled && plugin.content.trim())
    .map((plugin) => `## ${plugin.name}\n\n${plugin.content}`).join('\n\n');
  pi.on('before_agent_start', (event) => {
    if (!sections) return;
    return { systemPrompt: `${event.systemPrompt}\n\n# 应用上下文\n\n${sections}` };
  });
}
