import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageStream } from './MessageStream';

it('展示工具执行中状态、参数及完成结果', () => {
  const html = renderToStaticMarkup(<MessageStream messages={[]} loading={false} streamErrors={[]} draft={{ runId: 'r', text: '', tools: [
    { callId: 'a', name: 'read_file', argsSummary: 'path: example.txt', phase: 'start' },
    { callId: 'b', name: 'write_file', argsSummary: 'path: out.txt', phase: 'end', resultSummary: '写入成功' },
  ] }} />);
  expect(html).toContain('执行中');
  expect(html).toContain('完成');
  expect(html).toContain('参数：path: out.txt');
  expect(html).toContain('结果：写入成功');
});
