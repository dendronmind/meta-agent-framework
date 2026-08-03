/**
 * MAF 统一配置模块
 *
 * 读取优先级：环境变量 > 项目级配置 > 全局配置 > 默认值
 *
 * 配置文件位置：
 *   全局：~/.meta-agent-framework/maf.config.json
 *   项目：<project-root>/maf.config.json
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ============================================================
// 类型定义
// ============================================================

/** 外部注册表类型 */
export type RegistryType = 'feishu' | 'none';
/** Server 侧 Meta-Agent-Server runtime（配置兼容 claude / claude-code） */
export type ServerRuntime = 'opencode' | 'codex' | 'claude' | 'claude-code';

export interface MafConfig {
  auth: {
    token: string;
  };
  server: {
    url: string;
    port: number;
    runtime?: ServerRuntime;
  };
  daemon: {
    port: number;
  };
  /** 外部注册表配置（决定 Agent 数据来源） */
  registry: {
    type: RegistryType;     // 'feishu' | 'none'（默认 none）
  };
  /** 飞书配置（仅 registry.type = 'feishu' 时需要） */
  feishu: {
    app_id: string;
    app_secret: string;
    api_url: string;
    bitable: {
      app_token: string;
      table_id: string;
      view_id: string;
    };
  };
}

// ============================================================
// 默认值（无任何组织/环境特定信息）
// ============================================================

const DEFAULTS: MafConfig = {
  auth: {
    token: '',
  },
  server: {
    url: '',       // 必须配置
    port: 3000,
  },
  daemon: {
    port: 4100,
  },
  registry: {
    type: 'none',  // 默认纯自注册模式（零配置可用）
  },
  feishu: {
    app_id: '',    // 仅 registry.type='feishu' 时需要
    app_secret: '',
    api_url: 'https://open.feishu.cn/open-apis',
    bitable: {
      app_token: '',
      table_id: '',
      view_id: '',
    },
  },
};

// ============================================================
// 配置读取
// ============================================================

let _config: MafConfig | null = null;

/** 从文件读取 JSON 配置，失败返回空对象 */
function readJsonFile(filePath: string): Record<string, any> {
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    }
  } catch {}
  return {};
}

/** 深度合并：base ← override，只覆盖 override 中有值的字段 */
function deepMerge(base: any, override: any): any {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (override[key] !== undefined && override[key] !== null && override[key] !== '') {
      if (typeof override[key] === 'object' && !Array.isArray(override[key]) && typeof base[key] === 'object') {
        result[key] = deepMerge(base[key], override[key]);
      } else {
        result[key] = override[key];
      }
    }
  }
  return result;
}

/**
 * 加载配置（缓存，只读一次）
 *
 * 优先级：环境变量 > 项目级配置 > 全局配置 > 默认值
 */
export function getConfig(projectRoot?: string): MafConfig {
  if (_config) return _config;

  // 1. 默认值
  let config = JSON.parse(JSON.stringify(DEFAULTS)) as MafConfig;

  // 2. 全局配置
  const globalPath = join(homedir(), '.meta-agent-framework', 'maf.config.json');
  config = deepMerge(config, readJsonFile(globalPath));

  // 3. 项目级配置
  if (projectRoot) {
    const projectPath = join(projectRoot, 'maf.config.json');
    config = deepMerge(config, readJsonFile(projectPath));
  }

  // 4. 环境变量覆盖（最高优先级）
  if (process.env.META_AGENT_SERVER) config.server.url = process.env.META_AGENT_SERVER;
  if (process.env.MAF_AUTH_TOKEN) config.auth.token = process.env.MAF_AUTH_TOKEN;
  if (process.env.META_AGENT_PORT || process.env.PORT) config.server.port = parseInt(process.env.META_AGENT_PORT || process.env.PORT || '3000');
  if (process.env.MAF_SERVER_RUNTIME) config.server.runtime = process.env.MAF_SERVER_RUNTIME as ServerRuntime;
  if (process.env.MAF_NODE_PORT) config.daemon.port = parseInt(process.env.MAF_NODE_PORT);
  if (process.env.MAF_REGISTRY_TYPE) config.registry.type = process.env.MAF_REGISTRY_TYPE as RegistryType;
  if (process.env.FEISHU_APP_ID) config.feishu.app_id = process.env.FEISHU_APP_ID;
  if (process.env.FEISHU_APP_SECRET) config.feishu.app_secret = process.env.FEISHU_APP_SECRET;
  if (process.env.FEISHU_API_URL) config.feishu.api_url = process.env.FEISHU_API_URL;
  if (process.env.FEISHU_BITABLE_APP_TOKEN) config.feishu.bitable.app_token = process.env.FEISHU_BITABLE_APP_TOKEN;
  if (process.env.FEISHU_BITABLE_TABLE_ID) config.feishu.bitable.table_id = process.env.FEISHU_BITABLE_TABLE_ID;
  if (process.env.FEISHU_BITABLE_VIEW_ID) config.feishu.bitable.view_id = process.env.FEISHU_BITABLE_VIEW_ID;

  // 5. 向后兼容：旧配置有 feishu.app_id 但 registry.type 仍为默认 'none' → 自动升级为 'feishu'
  if (config.registry.type === 'none' && config.feishu.app_id) {
    config.registry.type = 'feishu';
  }

  _config = config;
  return config;
}

/** 重置缓存（测试用） */
export function resetConfig(): void {
  _config = null;
}
