import { describe, expect, it } from 'vitest';
import { configuredThinkingLevels, piThinkingLevels } from '../src/agent/thinking-capabilities.js';

describe('模型思考档位', () => {
  it('读取 Pi 标准档和显式扩展档，并排除禁用档', () => {
    expect(piThinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: null, xhigh: 'xhigh', max: 'max' } }))
      .toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(piThinkingLevels({ reasoning: false })).toEqual(['off']);
    expect(piThinkingLevels({ reasoning: true, thinkingLevelMap: { off: null } })).not.toContain('off');
  });
  it('区分未知档位与手动配置，并排除 Claude Code 不支持的最低档', () => {
    expect(configuredThinkingLevels(undefined, true, 'pi')).toBeNull();
    expect(configuredThinkingLevels(['minimal', 'high', 'max'], true, 'claude-code')).toEqual(['off', 'high', 'max']);
    expect(configuredThinkingLevels(['minimal', 'high', 'max'], true, 'pi')).toEqual(['off', 'minimal', 'high', 'max']);
    expect(configuredThinkingLevels(undefined, false, 'claude-code')).toEqual(['off']);
  });
});
