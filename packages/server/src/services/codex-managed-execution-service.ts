import type { Agent, CodexDeliveryMode } from '../types';
import { getConfig } from '../config';
import { codexConversationService, type CodexTurn } from './codex-conversation-service';

export interface ManagedCodexBinding {
  conversation_id: string;
  turn_id: string;
  thread_id: string;
}

export interface ManagedCodexLink {
  source_type: 'workflow' | 'task';
  workflow_id?: string;
  node_id?: string;
  execution_id?: string;
  task_id?: string;
}

export function resolveCodexDelivery(value: unknown, detached?: boolean): CodexDeliveryMode {
  if (detached === true) return 'detached';
  if (detached === false) return 'attached';
  const normalized = String(value || '').trim().toLowerCase();
  if (['managed', 'app-server', 'app_server', 'conversation', 'realtime'].includes(normalized)) return 'managed';
  if (['detached', 'screen', 'tui', 'daemon', 'offline'].includes(normalized)) return 'detached';
  if (['attached', 'current', 'foreground'].includes(normalized)) return 'attached';
  if (['auto', 'fallback'].includes(normalized)) return 'auto';
  return getConfig().codex.workflow_delivery;
}

class CodexManagedExecutionService {
  create(
    agent: Agent,
    _title: string,
    input: string,
    link: ManagedCodexLink,
  ): ManagedCodexBinding {
    const { conversation } = codexConversationService.getOrCreateAgentConversation(agent);
    const turn = codexConversationService.createTurn(conversation.id, input, link);
    codexConversationService.appendInternalEvent(conversation.id, turn.id, 'maf/userMessage', {
      text: input,
      source_type: link.source_type,
      workflow_id: link.workflow_id || '',
      node_id: link.node_id || '',
      execution_id: link.execution_id || '',
      task_id: link.task_id || '',
    });
    return { conversation_id: conversation.id, turn_id: turn.id, thread_id: conversation.thread_id };
  }

  fail(binding: ManagedCodexBinding | undefined, error: unknown): CodexTurn | undefined {
    if (!binding) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    codexConversationService.failTurn(binding.turn_id, message);
    codexConversationService.appendInternalEvent(binding.conversation_id, binding.turn_id, 'maf/turnFailed', {
      error: message,
      phase: 'dispatch',
    });
    return codexConversationService.getTurn(binding.turn_id);
  }
}

export const codexManagedExecutionService = new CodexManagedExecutionService();
