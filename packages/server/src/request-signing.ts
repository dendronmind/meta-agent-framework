import { createHash, randomBytes, sign, verify } from 'crypto';

export const SIGNATURE_MAX_AGE_MS = 60_000;

export interface SignedHeaders {
  'X-MAF-Role': 'client' | 'server';
  'X-MAF-ID': string;
  'X-MAF-Timestamp': string;
  'X-MAF-Nonce': string;
  'X-MAF-Signature': string;
}

export function requestTarget(url: string): string {
  const parsed = new URL(url, 'http://maf.local');
  return `${parsed.pathname}${parsed.search}`;
}

export function requestBodyBuffer(body?: string | Buffer): Buffer {
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(body || '', 'utf-8');
}

export function canonicalRequest(
  method: string,
  target: string,
  timestamp: string,
  nonce: string,
  body?: string | Buffer,
): Buffer {
  const bodyHash = createHash('sha256').update(requestBodyBuffer(body)).digest('hex');
  return Buffer.from([
    method.toUpperCase(),
    requestTarget(target),
    timestamp,
    nonce,
    bodyHash,
  ].join('\n'), 'utf-8');
}

export function createSignedHeaders(
  privateKeyPem: string,
  role: 'client' | 'server',
  id: string,
  method: string,
  target: string,
  body?: string | Buffer,
): SignedHeaders {
  const timestamp = String(Date.now());
  const nonce = randomBytes(18).toString('base64url');
  const signature = sign(
    null,
    canonicalRequest(method, target, timestamp, nonce, body),
    privateKeyPem,
  ).toString('base64url');
  return {
    'X-MAF-Role': role,
    'X-MAF-ID': id,
    'X-MAF-Timestamp': timestamp,
    'X-MAF-Nonce': nonce,
    'X-MAF-Signature': signature,
  };
}

export function verifySignedRequest(
  publicKeyPem: string,
  method: string,
  target: string,
  body: string | Buffer | undefined,
  timestamp: string,
  nonce: string,
  signature: string,
  now = Date.now(),
): boolean {
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > SIGNATURE_MAX_AGE_MS) return false;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return false;
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(signature)) return false;
  try {
    return verify(
      null,
      canonicalRequest(method, target, timestamp, nonce, body),
      publicKeyPem,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
