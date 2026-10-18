const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const http = require('node:http');
const { SupabaseSessionStore } = require('../supabase-session-store');

let remoteServer;
let store;
let sessions;
let requests;
const testServiceRoleKey = randomBytes(32).toString('hex');

test.before(async () => {
  sessions = new Map();
  requests = [];
  remoteServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, url, apiKey: req.headers.apikey });
    const respond = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === null ? '' : JSON.stringify(body));
    };

    if (url.pathname === '/rest/v1/admin_sessions' && req.method === 'POST') {
      let rawBody = '';
      for await (const chunk of req) rawBody += chunk;
      const row = JSON.parse(rawBody);
      sessions.set(row.id, row);
      return respond(201, []);
    }
    if (url.pathname === '/rest/v1/admin_sessions' && req.method === 'GET') {
      const id = url.searchParams.get('id')?.replace('eq.', '');
      return respond(200, sessions.has(id) ? [sessions.get(id)] : []);
    }
    if (url.pathname === '/rest/v1/admin_sessions' && req.method === 'DELETE') {
      const id = url.searchParams.get('id')?.replace('eq.', '');
      if (id) sessions.delete(id);
      else {
        const expiredBefore = Date.parse(url.searchParams.get('expires_at')?.replace('lt.', ''));
        sessions.forEach((row, key) => {
          if (Date.parse(row.expires_at) < expiredBefore) sessions.delete(key);
        });
      }
      return respond(204, null);
    }
    if (url.pathname === '/rest/v1/rpc/consume_admin_login_attempt' && req.method === 'POST') {
      return respond(200, [{ allowed: true, retry_after_seconds: 900 }]);
    }
    if (url.pathname === '/rest/v1/admin_login_attempts' && req.method === 'DELETE') {
      return respond(204, null);
    }

    return respond(404, { message: 'Unexpected REST request' });
  });

  await new Promise((resolve) => remoteServer.listen(0, '127.0.0.1', resolve));
  process.env.SUPABASE_URL = `http://127.0.0.1:${remoteServer.address().port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = testServiceRoleKey;
  store = new SupabaseSessionStore();
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    remoteServer.close((error) => (error ? reject(error) : resolve()));
  });
});

test('Supabase admin sessions store only a hash of the opaque session ID', async () => {
  const sessionId = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 60000;
  const storageId = createHash('sha256').update(sessionId).digest('hex');

  await store.initialize();
  await store.set(sessionId, { authenticated: true }, expiresAt);

  assert.equal(sessions.has(sessionId), false);
  assert.deepEqual(sessions.get(storageId).session_data, { authenticated: true });
  assert.equal((await store.get(sessionId)).authenticated, true);
  await store.destroy(sessionId);
  assert.equal(sessions.has(storageId), false);
  assert.ok(requests.every((request) => request.apiKey === testServiceRoleKey));
});

test('Supabase admin login throttling uses the shared rate-limit RPC', async () => {
  const key = createHash('sha256').update(randomBytes(16)).digest('hex');
  const result = await store.consumeLoginAttempt(key, Date.now(), 900000, 5);

  assert.deepEqual(result, { allowed: true, retry_after_seconds: 900 });
  const request = requests.find((item) =>
    item.url.pathname === '/rest/v1/rpc/consume_admin_login_attempt'
  );
  assert.ok(request);
  await store.resetLoginAttempts(key);
  assert.ok(requests.some((item) =>
    item.method === 'DELETE' && item.url.pathname === '/rest/v1/admin_login_attempts'
  ));
});
