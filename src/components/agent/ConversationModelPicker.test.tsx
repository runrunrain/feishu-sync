// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { AgentSessionDto } from '../../types/agent';

const listModels = vi.hoisted(() => vi.fn(async () => ({ items: [
  { source: 'app-llm', providerId: 'p', modelId: 'm', label: '模型', reasoning: true, thinkingLevels: ['off', 'low', 'xhigh', 'max'] },
], message: '' })));
const saveModel = vi.hoisted(() => vi.fn(async () => ({})));
const config = vi.hoisted(() => ({ llm: { activeProviderId: 'p', activeModelId: 'm', providers: [{ id: 'p', models: [{ id: 'm', name: '模型', reasoning: true }] }] }, agent: { model: { source: 'app-llm', thinkingLevel: 'off' } } }));
vi.mock('../../api/client', () => ({ listConversationModels: listModels, saveConversationModel: saveModel }));
vi.mock('../../hooks/useConfig', () => ({ useConfig: () => ({ config }) }));
vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { ConversationModelPicker } from './ConversationModelPicker';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('仅显示该模型的档位，并保存扩展档位', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ConversationModelPicker session={{ id: 's', backend: 'claude-code', model: null } as AgentSessionDto} busy={false} onChanged={() => {}} />));
    await act(async () => (container.querySelector('[aria-label="调整模型思考强度"]') as HTMLButtonElement).click());
    expect(container.querySelector('[aria-label="极高思考"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="最大思考"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="中思考"]')).toBeNull();
    await act(async () => (container.querySelector('[aria-label="极高思考"]') as HTMLButtonElement).click());
    expect(saveModel).toHaveBeenCalledWith('s', expect.objectContaining({ thinkingLevel: 'xhigh' }));
  } finally { act(() => root.unmount()); container.remove(); }
});
