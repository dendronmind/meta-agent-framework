(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MafCodexProcess = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function itemId(payload) {
    const value = asObject(payload);
    return String(asObject(value.item).id || value.itemId || '');
  }

  function turnId(event) {
    const payload = asObject(event && event.payload);
    return String(event && event.turn_id || payload.turnId || asObject(payload.turn).id || '');
  }

  function itemKind(type) {
    return ({
      reasoning: 'reasoning',
      plan: 'plan',
      commandExecution: 'command',
      fileChange: 'files',
      mcpToolCall: 'mcp',
      dynamicToolCall: 'tool',
      collabAgentToolCall: 'collaboration',
      subAgentActivity: 'subagent',
      webSearch: 'web',
      imageView: 'image',
      imageGeneration: 'image',
      enteredReviewMode: 'review',
      exitedReviewMode: 'review',
      contextCompaction: 'compaction',
      sleep: 'wait',
    })[String(type || '')] || '';
  }

  function normalizedStatus(value, fallback) {
    const raw = typeof value === 'string' ? value : String(asObject(value).type || '');
    if (['completed', 'done', 'success', 'succeeded', 'idle'].includes(raw)) return 'completed';
    if (['failed', 'error', 'declined'].includes(raw)) return 'failed';
    if (['interrupted', 'cancelled', 'canceled'].includes(raw)) return 'interrupted';
    if (['inProgress', 'running', 'active', 'starting', 'queued'].includes(raw)) return 'running';
    return fallback || 'running';
  }

  function itemText(item) {
    const value = asObject(item);
    switch (value.type) {
      case 'reasoning':
        return (Array.isArray(value.summary) ? value.summary : []).filter(Boolean).join('\n');
      case 'plan':
        return String(value.text || '');
      case 'commandExecution':
        return String(value.command || '');
      case 'mcpToolCall':
        return [value.server, value.tool].filter(Boolean).join(' / ');
      case 'dynamicToolCall':
        return [value.namespace, value.tool].filter(Boolean).join(' / ');
      case 'collabAgentToolCall':
        return String(value.prompt || value.tool || '');
      case 'subAgentActivity':
        return String(value.agentPath || value.kind || '');
      case 'webSearch':
        return String(value.query || asObject(value.action).query || '');
      case 'imageView':
        return String(value.path || '');
      case 'imageGeneration':
        return String(value.revisedPrompt || value.savedPath || '');
      case 'enteredReviewMode':
      case 'exitedReviewMode':
        return String(value.review || '');
      default:
        return '';
    }
  }

  function itemDetail(item) {
    const value = asObject(item);
    if (value.type === 'commandExecution') return String(value.aggregatedOutput || '');
    if (value.type === 'fileChange') {
      return (Array.isArray(value.changes) ? value.changes : [])
        .map(change => String(asObject(change).diff || ''))
        .filter(Boolean)
        .join('\n');
    }
    if (value.type === 'mcpToolCall') {
      if (value.error) return String(asObject(value.error).message || JSON.stringify(value.error));
      if (value.result) return JSON.stringify(value.result, null, 2);
    }
    if (value.type === 'dynamicToolCall' && value.contentItems) return JSON.stringify(value.contentItems, null, 2);
    return '';
  }

  function itemFiles(item) {
    const value = asObject(item);
    if (value.type !== 'fileChange') return [];
    return (Array.isArray(value.changes) ? value.changes : []).map(change => ({
      path: String(asObject(change).path || ''),
      kind: String(asObject(change).kind || ''),
    })).filter(change => change.path);
  }

  function aggregateCodexProcess(events) {
    const source = Array.isArray(events) ? events : [];
    let ordered = true;
    let previousSeq = -Infinity;
    for (const event of source) {
      const seq = Number(event && event.seq || 0);
      if (seq < previousSeq) {
        ordered = false;
        break;
      }
      previousSeq = seq;
    }
    const sorted = ordered ? source : source.slice().sort((left, right) =>
      Number(left && left.seq || 0) - Number(right && right.seq || 0));
    const steps = [];
    const byKey = new Map();

    function upsert(key, initial) {
      let step = byKey.get(key);
      if (!step) {
        step = {
          key,
          kind: initial.kind || 'event',
          status: initial.status || 'running',
          text: '',
          detail: '',
          files: [],
          plan: [],
          technical: null,
          turnId: initial.turnId || '',
          createdAt: initial.createdAt || '',
          seq: Number(initial.seq || 0),
        };
        byKey.set(key, step);
        steps.push(step);
      }
      Object.assign(step, initial);
      return step;
    }

    function updateFromItem(event, status) {
      const payload = asObject(event.payload);
      const item = asObject(payload.item);
      const kind = itemKind(item.type);
      if (!kind || ['agentMessage', 'userMessage', 'hookPrompt'].includes(String(item.type || ''))) return null;
      const id = String(item.id || itemId(payload));
      if (!id) return null;
      const currentTurn = turnId(event);
      const step = upsert(`item:${currentTurn}:${id}`, {
        kind,
        status: normalizedStatus(item.status, status),
        turnId: currentTurn,
        createdAt: event.created_at || '',
        seq: event.seq,
      });
      const text = itemText(item);
      const detail = itemDetail(item);
      const files = itemFiles(item);
      if (text) step.text = text;
      if (detail) step.detail = detail;
      if (files.length) step.files = files;
      step.technical = item;
      return step;
    }

    for (const event of sorted) {
      const type = String(event && event.event_type || '');
      const payload = asObject(event && event.payload);
      const currentTurn = turnId(event);
      const id = itemId(payload);

      if (type === 'turn/started') {
        upsert(`turn-start:${currentTurn}`, {
          kind: 'turnStart', status: 'running', turnId: currentTurn,
          createdAt: event.created_at || '', seq: event.seq,
        });
        continue;
      }
      if (type === 'turn/completed') {
        upsert(`turn-complete:${currentTurn}`, {
          kind: 'turnComplete', status: normalizedStatus(asObject(payload.turn).status, 'completed'),
          turnId: currentTurn, createdAt: event.created_at || '', seq: event.seq,
          technical: asObject(payload.turn).error || null,
        });
        continue;
      }
      if (type === 'item/started') {
        updateFromItem(event, 'running');
        continue;
      }
      if (type === 'item/completed') {
        updateFromItem(event, 'completed');
        continue;
      }
      if (type === 'item/reasoning/summaryTextDelta' && id) {
        const step = upsert(`item:${currentTurn}:${id}`, {
          kind: 'reasoning', status: 'running', turnId: currentTurn,
          createdAt: event.created_at || '', seq: event.seq,
        });
        const index = Math.max(0, Number(payload.summaryIndex || 0));
        if (!step.summaryParts) step.summaryParts = [];
        step.summaryParts[index] = String(step.summaryParts[index] || '') + String(payload.delta || '');
        step.text = step.summaryParts.filter(Boolean).join('\n');
        continue;
      }
      if (type === 'item/plan/delta' && id) {
        const step = upsert(`item:${currentTurn}:${id}`, {
          kind: 'plan', status: 'running', turnId: currentTurn,
          createdAt: event.created_at || '', seq: event.seq,
        });
        step.text += String(payload.delta || '');
        continue;
      }
      if (type === 'turn/plan/updated') {
        const step = upsert(`turn-plan:${currentTurn}`, {
          kind: 'plan', status: 'running', turnId: currentTurn,
          createdAt: event.created_at || '', seq: event.seq,
        });
        step.text = String(payload.explanation || '');
        step.plan = (Array.isArray(payload.plan) ? payload.plan : []).map(item => ({
          text: String(asObject(item).step || ''),
          status: normalizedStatus(asObject(item).status, 'running'),
        })).filter(item => item.text);
        if (step.plan.length && step.plan.every(item => item.status === 'completed')) step.status = 'completed';
        continue;
      }
      if (type === 'item/commandExecution/outputDelta' && id) {
        const step = upsert(`item:${currentTurn}:${id}`, {
          kind: 'command', status: 'running', turnId: currentTurn,
          createdAt: event.created_at || '', seq: event.seq,
        });
        step.detail += String(payload.delta || '');
        continue;
      }
      if (type === 'item/fileChange/patchUpdated' && id) {
        upsert(`item:${currentTurn}:${id}`, {
          kind: 'files', status: 'running', turnId: currentTurn,
          createdAt: event.created_at || '', seq: event.seq,
        });
        continue;
      }
      if (type === 'item/mcpToolCall/progress' && id) {
        const step = upsert(`item:${currentTurn}:${id}`, {
          kind: 'mcp', status: 'running', turnId: currentTurn,
          createdAt: event.created_at || '', seq: event.seq,
        });
        step.detail = String(payload.message || step.detail || '');
        continue;
      }
      if (type === 'hook/started' || type === 'hook/completed') {
        const hook = asObject(payload.hook);
        upsert(`hook:${currentTurn}:${hook.id || payload.hookId || event.seq}`, {
          kind: 'hook', status: type.endsWith('/completed') ? 'completed' : 'running',
          text: String(hook.name || payload.name || ''), turnId: currentTurn,
          createdAt: event.created_at || '', seq: event.seq, technical: hook,
        });
        continue;
      }
      if (type === 'thread/compacted') {
        upsert(`compaction:${event.seq}`, {
          kind: 'compaction', status: 'completed', turnId: currentTurn,
          createdAt: event.created_at || '', seq: event.seq,
        });
        continue;
      }
      if (type === 'maf/interruptRequested') {
        upsert(`interrupt:${currentTurn}:${event.seq}`, {
          kind: 'interrupt', status: 'interrupted', turnId: currentTurn,
          createdAt: event.created_at || '', seq: event.seq,
        });
        continue;
      }
      if (/error|failed|exited/i.test(type)) {
        upsert(`error:${event.seq}`, {
          kind: 'error', status: 'failed', turnId: currentTurn,
          text: String(payload.error || payload.message || type),
          createdAt: event.created_at || '', seq: event.seq, technical: payload,
        });
      }
    }

    return steps.map(step => {
      const result = { ...step };
      delete result.summaryParts;
      return result;
    });
  }

  return { aggregateCodexProcess };
});
