const { createHash } = require('crypto');
const { SupabaseRestClient } = require('./supabase-rest-client');

class SupabaseSessionStore {
  constructor() {
    this.client = null;
  }

  getClient() {
    if (!this.client) {
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !serviceRoleKey) {
        const error = new Error('Supabase is not configured for admin sessions.');
        error.code = 'SUPABASE_NOT_CONFIGURED';
        throw error;
      }
      this.client = new SupabaseRestClient(supabaseUrl, serviceRoleKey);
    }
    return this.client;
  }

  async initialize() {
    await this.getClient().request('admin_sessions', {
      query: { select: 'id', limit: '1' },
    });
  }

  async get(id) {
    const storageId = createHash('sha256').update(id).digest('hex');
    const rows = await this.getClient().request('admin_sessions', {
      query: { select: 'session_data,expires_at', id: `eq.${storageId}` },
    });
    const row = rows[0];
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      await this.destroy(id);
      return null;
    }
    return row.session_data;
  }

  async set(id, session, expiresAt) {
    await this.getClient().request('admin_sessions', {
      method: 'DELETE',
      query: { expires_at: `lt.${new Date().toISOString()}` },
    });
    await this.getClient().request('admin_sessions', {
      method: 'POST',
      query: { on_conflict: 'id' },
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: {
        id: createHash('sha256').update(id).digest('hex'),
        session_data: session,
        expires_at: new Date(expiresAt).toISOString(),
      },
    });
  }

  async destroy(id) {
    await this.getClient().request('admin_sessions', {
      method: 'DELETE',
      query: { id: `eq.${createHash('sha256').update(id).digest('hex')}` },
    });
  }

  async consumeLoginAttempt(key, now, windowMs, maxAttempts) {
    const rows = await this.getClient().request('rpc/consume_admin_login_attempt', {
      method: 'POST',
      body: {
        p_key: key,
        p_now: new Date(now).toISOString(),
        p_window_seconds: Math.ceil(windowMs / 1000),
        p_max_attempts: maxAttempts,
      },
    });
    return rows[0];
  }

  async resetLoginAttempts(key) {
    await this.getClient().request('admin_login_attempts', {
      method: 'DELETE',
      query: { key: `eq.${key}` },
    });
  }
}

module.exports = { SupabaseSessionStore };
