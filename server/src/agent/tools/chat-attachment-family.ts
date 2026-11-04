import { ChatAttachmentStore, ChatAttachmentError } from '../chat-attachments.js';
import { ToolError, type AgentToolFamily } from '../agent-tool-service.js';
import { CHAT_ATTACHMENT_READ_SPEC } from '../tool-specs.js';

export function createChatAttachmentFamily(dataRoot: string): AgentToolFamily {
  const store = new ChatAttachmentStore(dataRoot);
  return {
    name: 'chat-attachments',
    tools: [{
      spec: CHAT_ATTACHMENT_READ_SPEC,
      runKinds: ['discuss', 'work'],
      execute: (context, args) => {
        if (!context.options.sessionId) throw new ToolError('attachment_not_found', '本运行没有会话附件', 404);
        try {
          const result = store.readText(context.options.sessionId, String(args.attachmentId ?? ''),
            args.offset === undefined ? 0 : Number(args.offset), args.limit === undefined ? 200 : Number(args.limit));
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        } catch (error) {
          if (error instanceof ChatAttachmentError) throw new ToolError(error.code, error.message, error.status);
          throw error;
        }
      },
    }],
  };
}
