import { createHash, createPublicKey } from 'crypto';
import { getDb } from '../db/database';

export type ClientIdentityStatus = 'pending' | 'active' | 'revoked';

export interface ClientIdentity {
  client_id: string;
  public_key: string;
  public_key_fingerprint: string;
  status: ClientIdentityStatus;
  client_endpoint: string;
  hostname: string;
  user_id: string;
  host_user: string;
  source_ip: string;
  created_at: string;
  approved_at: string;
  last_seen_at: string;
}

export interface EnrollmentPayload {
  client_id: string;
  public_key: string;
  client_endpoint?: string;
  hostname?: string;
  user_id?: string;
  host_user?: string;
}

function publicKeyFingerprint(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 24);
}

function normalizeIp(raw: string): string {
  const ip = String(raw || '').trim().split(',')[0].trim();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isPrivateIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some(part => part < 0 || part > 255)) return false;
    return octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
  }
  const lower = ip.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9')
    || lower.startsWith('fea') || lower.startsWith('feb');
}

function enrollmentMode(): 'auto' | 'approval' | 'disabled' {
  const value = String(process.env.MAF_ENROLLMENT_MODE || 'auto').trim().toLowerCase();
  if (value === 'approval' || value === 'disabled') return value;
  return 'auto';
}

function validatePublicKey(publicKey: string): boolean {
  if (publicKey.length < 80 || publicKey.length > 2048) return false;
  try {
    const key = createPublicKey(publicKey);
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

class ClientIdentityService {
  enroll(payload: EnrollmentPayload, sourceIp: string): { identity: ClientIdentity; created: boolean } {
    const clientId = String(payload.client_id || '').trim();
    const publicKey = String(payload.public_key || '').trim();
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(clientId)) throw new Error('invalid_client_id');
    if (!validatePublicKey(publicKey)) throw new Error('invalid_public_key');

    const db = getDb();
    const existing = this.get(clientId);
    const now = new Date().toISOString();
    const endpoint = String(payload.client_endpoint || '').slice(0, 512);
    const hostname = String(payload.hostname || '').slice(0, 255);
    const userId = String(payload.user_id || '').slice(0, 255);
    const hostUser = String(payload.host_user || '').slice(0, 255);
    const ip = normalizeIp(sourceIp).slice(0, 128);

    if (existing) {
      if (existing.public_key !== publicKey) throw new Error('client_key_mismatch');
      db.prepare(`
        UPDATE client_identities
        SET client_endpoint = ?, hostname = ?, user_id = ?, host_user = ?, source_ip = ?, last_seen_at = ?
        WHERE client_id = ?
      `).run(endpoint, hostname, userId, hostUser, ip, now, clientId);
      return { identity: this.get(clientId)!, created: false };
    }

    const mode = enrollmentMode();
    if (mode === 'disabled') throw new Error('enrollment_disabled');
    const autoApproved = mode === 'auto'
      && (isPrivateIp(ip) || process.env.MAF_ENROLLMENT_ALLOW_PUBLIC === '1');
    const status: ClientIdentityStatus = autoApproved ? 'active' : 'pending';
    db.prepare(`
      INSERT INTO client_identities (
        client_id, public_key, public_key_fingerprint, status, client_endpoint,
        hostname, user_id, host_user, source_ip, created_at, approved_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      clientId, publicKey, publicKeyFingerprint(publicKey), status, endpoint,
      hostname, userId, hostUser, ip, now, autoApproved ? now : '', now,
    );
    return { identity: this.get(clientId)!, created: true };
  }

  get(clientId: string): ClientIdentity | undefined {
    return getDb().prepare('SELECT * FROM client_identities WHERE client_id = ?').get(clientId) as ClientIdentity | undefined;
  }

  list(): Omit<ClientIdentity, 'public_key'>[] {
    return getDb().prepare(`
      SELECT client_id, public_key_fingerprint, status, client_endpoint, hostname,
             user_id, host_user, source_ip, created_at, approved_at, last_seen_at
      FROM client_identities ORDER BY created_at DESC
    `).all() as Omit<ClientIdentity, 'public_key'>[];
  }

  approve(clientId: string): ClientIdentity | undefined {
    const now = new Date().toISOString();
    getDb().prepare(`
      UPDATE client_identities SET status = 'active', approved_at = ?, last_seen_at = ? WHERE client_id = ?
    `).run(now, now, clientId);
    return this.get(clientId);
  }

  revoke(clientId: string): ClientIdentity | undefined {
    getDb().prepare("UPDATE client_identities SET status = 'revoked' WHERE client_id = ?").run(clientId);
    return this.get(clientId);
  }

  touch(clientId: string): void {
    getDb().prepare('UPDATE client_identities SET last_seen_at = ? WHERE client_id = ?')
      .run(new Date().toISOString(), clientId);
  }
}

export const clientIdentityService = new ClientIdentityService();
