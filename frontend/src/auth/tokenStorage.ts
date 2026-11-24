const TOKEN_KEY = 'jps_token';
const IDENTITY_KEY = 'jps_identity';

// Shared credentials are read and mutated under one origin-wide lock. If
// the browser refuses shared storage or lacks Web Locks, keep that tab's
// session in memory. It can still refresh without publishing an unguarded
// token for other tabs to pick up.
type Session = { epoch: string | null; token: string | null };
let local: Session | null = null;

function current(): Session {
  if (local) return local;
  try {
    return { epoch: localStorage.getItem(IDENTITY_KEY), token: localStorage.getItem(TOKEN_KEY) };
  } catch {
    return local = { epoch: null, token: null };
  }
}

function locked<T>(work: () => T): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('uncle-owen-session', work).catch(error => {
      if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error;
      local ??= current();
      return work();
    });
  }
  local ??= current();
  return Promise.resolve(work());
}

export function readSession(): Promise<Session> {
  return locked(current);
}

export function authEpoch(): string | null {
  return current().epoch;
}

export function getToken(): string | null {
  return current().token;
}

function write(next: Session, identityChange: boolean): void {
  if (!local) {
    try {
      if (identityChange) localStorage.setItem(IDENTITY_KEY, next.epoch!);
      if (next.token === null) localStorage.removeItem(TOKEN_KEY);
      else localStorage.setItem(TOKEN_KEY, next.token);
      return;
    } catch {
      // Do not leave an older token usable under a newly written marker.
      try { localStorage.removeItem(TOKEN_KEY); } catch { /* Storage is unavailable. */ }
    }
  }
  local = next;
}

export function refreshSession(epoch: string | null, token: string): Promise<boolean> {
  return locked(() => {
    if (current().epoch !== epoch) return false;
    write({ epoch, token }, false);
    return true;
  });
}

function newEpoch(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now() + '-' + Math.random();
}

export function adoptSession(token: string): Promise<void> {
  return locked(() => write({ epoch: newEpoch(), token }, true));
}

// The previous token is returned to the logout caller for server revocation.
// An automatic logout for an obsolete request leaves the current user alone.
export function clearToken(expectedEpoch?: string | null): Promise<{ cleared: boolean; token: string | null }> {
  return locked(() => {
    const session = current();
    if (expectedEpoch !== undefined && expectedEpoch !== session.epoch) return { cleared: false, token: null };
    write({ epoch: newEpoch(), token: null }, true);
    return { cleared: true, token: session.token };
  });
}

// Decodes the JWT payload without verifying it (verification happens
// server-side on every request); used only to read `exp` for a client-side
// "should we bother sending this token" check.
export function decodeTokenPayload(token: string): { sub: string; exp: number; sid?: string } | null {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string): boolean {
  const payload = decodeTokenPayload(token);
  if (!payload) return true;
  return payload.exp * 1000 < Date.now();
}
