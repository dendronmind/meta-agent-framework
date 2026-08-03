import { Router, Request, Response } from 'express';
import { eventBus } from '../services/event-bus';
import { agentRegistry } from '../services/agent-registry';
import type { SSEEvent } from '../types';

const router = Router();

/** GET /api/events — SSE 事件流（Web Dashboard 订阅） */
router.get('/', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 发送初始连接确认
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'SSE connected', timestamp: new Date().toISOString() })}\n\n`);

  const principal = res.locals.mafPrincipal;
  const filter = principal?.role === 'client'
    ? (event: SSEEvent) => {
      if (event.type !== 'workflow_completed' && event.type !== 'workflow_failed') return false;
      const origin = event.data.origin as Record<string, unknown> | undefined;
      const originAgent = String(origin?.agent_name || '');
      return agentRegistry.clientOwnsAgent(principal.id, originAgent);
    }
    : undefined;

  // Admin 订阅全量事件；Client 仅订阅本机 Agent 发起的终态通知。
  eventBus.subscribe(res, filter);

  console.log(`[SSE] Client connected (total: ${eventBus.subscriberCount})`);

  req.on('close', () => {
    console.log(`[SSE] Client disconnected (total: ${eventBus.subscriberCount})`);
  });
});

export default router;
