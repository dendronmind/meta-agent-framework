import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request, RequestHandler } from 'express';
import { getConfig } from './config';
import { clientIdentityService } from './services/client-identity-service';
import { createSignedHeaders, verifySignedRequest } from './request-signing';

const MAF_HOME = process.env.MAF_HOME || path.join(os.homedir(), '.meta-agent-framework');
const AUTH_DIR = path.join(MAF_HOME, 'auth');
const ADMIN_TOKEN_FILE = path.join(AUTH_DIR, 'admin-token');
const SERVER_PRIVATE_KEY_FILE = path.join(AUTH_DIR, 'server-private.pem');
const SERVER_PUBLIC_KEY_FILE = path.join(AUTH_DIR, 'server-public.pem');
const seenNonces = new Map<string, number>();

function writeSecret(file: string, value: string, mode = 0o600): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode });
  try { fs.chmodSync(file, mode); } catch {}
}

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf-8').trim(); } catch { return ''; }
}

export function ensureServerIdentity(): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(AUTH_DIR, 0o700); } catch {}
  if (!readText(ADMIN_TOKEN_FILE) && !process.env.MAF_AUTH_TOKEN && !getConfig().auth.token) {
    writeSecret(ADMIN_TOKEN_FILE, `${randomBytes(32).toString('base64url')}\n`);
  }
  const privateKeyPem = readText(SERVER_PRIVATE_KEY_FILE);
  if (privateKeyPem) {
    try {
      const publicKeyPem = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
      if (readText(SERVER_PUBLIC_KEY_FILE) !== publicKeyPem.trim()) {
        writeSecret(SERVER_PUBLIC_KEY_FILE, publicKeyPem, 0o644);
      }
      return;
    } catch {
      // Invalid private key: generate a new Server identity below.
    }
  }
  {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeSecret(SERVER_PRIVATE_KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    writeSecret(SERVER_PUBLIC_KEY_FILE, publicKey.export({ type: 'spki', format: 'pem' }).toString(), 0o644);
  }
}

function configuredToken(): string {
  ensureServerIdentity();
  return String(process.env.MAF_AUTH_TOKEN || getConfig().auth.token || readText(ADMIN_TOKEN_FILE)).trim();
}

export function getAuthToken(): string {
  const token = configuredToken();
  if (!/^[A-Za-z0-9._~+/=-]{32,512}$/.test(token)) {
    throw new Error('MAF admin token must be 32-512 token characters.');
  }
  return token;
}

export function getServerPublicKey(): string {
  ensureServerIdentity();
  return fs.readFileSync(SERVER_PUBLIC_KEY_FILE, 'utf-8');
}

function getServerPrivateKey(): string {
  ensureServerIdentity();
  return fs.readFileSync(SERVER_PRIVATE_KEY_FILE, 'utf-8');
}

export function adminAuthHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return { ...headers, Authorization: `Bearer ${getAuthToken()}` };
}

export function serverAuthHeaders(
  method: string,
  url: string,
  body = '',
  headers: Record<string, string> = {},
): Record<string, string> {
  return {
    ...headers,
    ...createSignedHeaders(getServerPrivateKey(), 'server', 'maf-server', method, url, body),
  };
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isLoopbackRequest(req: Request): boolean {
  const address = String(req.socket.remoteAddress || '').toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function rawBody(req: Request): Buffer {
  return (req as Request & { rawBody?: Buffer }).rawBody || Buffer.alloc(0);
}

export function acceptSignedNonce(principalId: string, nonce: string, timestamp: string): boolean {
  const now = Date.now();
  for (const [key, expiresAt] of seenNonces) {
    if (expiresAt <= now) seenNonces.delete(key);
  }
  const key = `${principalId}:${nonce}`;
  if (seenNonces.has(key)) return false;
  seenNonces.set(key, Number(timestamp) + 60_000);
  return true;
}

function clientPathAllowed(req: Request): boolean {
  const method = req.method.toUpperCase();
  const pathName = new URL(req.originalUrl, 'http://maf.local').pathname.replace(/^\/api/, '');
  if (method === 'POST' && /^\/clients\/(register|heartbeat|sync)$/.test(pathName)) return true;
  if (method === 'GET' && pathName === '/clients/my-agents') return true;
  if (method === 'GET' && pathName === '/events') return true;
  if (method === 'GET' && pathName === '/tasks/poll') return true;
  if (method === 'POST' && /^\/tasks\/[^/]+\/(result|claim)$/.test(pathName)) return true;
  if (method === 'POST' && /^\/workflows\/[^/]+\/nodes\/[^/]+\/(started|result)$/.test(pathName)) return true;
  if (method === 'POST' && /^\/v1\/executions\/[^/]+\/patch$/.test(pathName)) return true;
  if (method === 'POST' && /^\/codex\/conversations\/[^/]+\/events$/.test(pathName)) return true;
  if (method === 'POST' && /^\/evolve\/[^/]+\/result$/.test(pathName)) return true;
  if (method === 'POST' && pathName === '/proposals') return true;
  if (method === 'GET' && pathName === '/proposals') return true;
  return false;
}

const PUBLIC_DASHBOARD_READ_PATHS = new Set([
  '/api/agents',
  '/api/agents/inventory',
  '/api/auth/clients',
  '/api/events',
  '/api/evolve',
  '/api/ota/status',
  '/api/tasks',
  '/api/workflows',
  '/api/workflows/mas/sessions',
]);

function publicDashboardReadAllowed(req: Request): boolean {
  if (req.method.toUpperCase() !== 'GET') return false;
  const url = new URL(req.originalUrl, 'http://maf.local');
  return PUBLIC_DASHBOARD_READ_PATHS.has(url.pathname)
    || /^\/api\/codex\/conversations(?:\/[^/]+(?:\/(?:events|stream))?)?$/.test(url.pathname);
}

export const requireApiAuth: RequestHandler = (req, res, next) => {
  const role = req.get('x-maf-role') || '';
  const clientId = req.get('x-maf-id') || '';
  if (role === 'client') {
    const timestamp = req.get('x-maf-timestamp') || '';
    const nonce = req.get('x-maf-nonce') || '';
    const signature = req.get('x-maf-signature') || '';
    const identity = clientIdentityService.get(clientId);
    const verified = identity?.status === 'active'
      && verifySignedRequest(identity.public_key, req.method, req.originalUrl, rawBody(req), timestamp, nonce, signature)
      && acceptSignedNonce(`client:${clientId}`, nonce, timestamp);
    if (!verified) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!clientPathAllowed(req)) {
      res.status(403).json({ error: 'Client credential is not allowed for this endpoint' });
      return;
    }
    const apiPath = new URL(req.originalUrl, 'http://maf.local').pathname.replace(/^\/api/, '');
    if (/^\/clients\/(register|heartbeat|sync)$/.test(apiPath) && req.body?.client_id !== clientId) {
      res.status(403).json({ error: 'Client identity mismatch' });
      return;
    }
    if (/^\/clients\/(register|heartbeat|sync)$/.test(apiPath)
        && ((identity.user_id && req.body?.user_id !== identity.user_id)
          || (identity.host_user && String(req.body?.host_user || '') !== identity.host_user))) {
      res.status(403).json({ error: 'Client machine metadata mismatch' });
      return;
    }
    if (apiPath === '/clients/my-agents'
        && ((identity.user_id && req.query.user_id !== identity.user_id)
          || (identity.host_user && String(req.query.host_user || '') !== identity.host_user))) {
      res.status(403).json({ error: 'Client machine metadata mismatch' });
      return;
    }
    clientIdentityService.touch(clientId);
    res.locals.mafPrincipal = { role: 'client', id: clientId };
    next();
    return;
  }

  // Only processes on the Server machine receive management authority without a token.
  // socket.remoteAddress is used deliberately; forwarded headers are not trusted.
  if (isLoopbackRequest(req)) {
    res.locals.mafPrincipal = { role: 'admin', id: 'maf-server-local' };
    next();
    return;
  }

  const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (req.method.toUpperCase() === 'GET' && bearer && tokenMatches(bearer[1], getAuthToken())) {
    res.locals.mafPrincipal = { role: 'admin', id: 'maf-server-readonly' };
    next();
    return;
  }

  // Remote dashboards are public and read-only. Client task polling, machine
  // configuration reads, and every mutating endpoint remain authenticated.
  if (publicDashboardReadAllowed(req)) {
    next();
    return;
  }

  res.status(401).json({ error: 'Local Server access or Client signature required' });
};

export const requireAdminAuth: RequestHandler = (_req, res, next) => {
  if (res.locals.mafPrincipal?.role !== 'admin') {
    res.status(403).json({ error: 'Admin credential required' });
    return;
  }
  next();
};

export function requestRawBody(req: Request): Buffer {
  return rawBody(req);
}
