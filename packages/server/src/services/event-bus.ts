import type { Response } from 'express';
import type { SSEEvent } from '../types';

/**
 * 简单的 SSE 事件总线
 * Web Dashboard 通过 GET /events 订阅，所有系统事件通过这里广播
 */
export class EventBus {
  private clients: Set<Response> = new Set();

  /** 注册一个 SSE 客户端 */
  subscribe(res: Response): void {
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  /** 广播事件给所有订阅者 */
  emit(event: SSEEvent): void {
    const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(data);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /** 当前订阅者数量 */
  get subscriberCount(): number {
    return this.clients.size;
  }

  /** Server 退出时主动关闭所有 SSE 连接，避免 keep-alive 连接拖住进程 */
  closeAll(reason = 'server_shutdown'): void {
    const event: SSEEvent = {
      type: 'server_shutdown',
      data: { reason },
      timestamp: new Date().toISOString(),
    } as SSEEvent;
    const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try { client.write(data); } catch {}
      try { client.end(); } catch {}
    }
    this.clients.clear();
  }
}

export const eventBus = new EventBus();
