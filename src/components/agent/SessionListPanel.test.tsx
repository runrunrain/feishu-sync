import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionListPanel } from './SessionListPanel';
import type { AgentSessionDto } from '../../types/agent';

it('Chat 列出普通会话，Work 显示工作区及其会话', () => {
  const workspace = { id: 'w', name: '示例工作区', path: 'D:/example', createdAt: '' };
  const session = { id: 's', title: '会话标题', mode: 'discuss', state: 'idle', workspace, lastError: null, createdAt: '', updatedAt: '' } as AgentSessionDto;
  const props = { sessions: [session], loading: false, activeId: 's', workspaces: [workspace], onSelect: () => {}, onCreate: () => {}, onAddWorkspace: () => {}, onRename: async () => true, onDelete: async () => true };
  const chat = renderToStaticMarkup(<SessionListPanel {...props} />);
  expect(chat).toContain('会话标题'); expect(chat).not.toContain('示例工作区'); expect(chat).not.toContain('新建工作区');
  const work = renderToStaticMarkup(<SessionListPanel {...props} workspaceMode />);
  expect(work).toContain('示例工作区'); expect(work).toContain('在 示例工作区 新建会话'); expect(work).toContain('新建工作区');
});
