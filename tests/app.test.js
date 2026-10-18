const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createApp, startServer, validateEnvironment } = require('../server');

let server;
let orderStore;
let sessionStore;
let adminCookie;
const testAdminUsername = randomBytes(8).toString('hex');
const testAdminPassword = randomBytes(32).toString('hex');
const wrongPassword = randomBytes(32).toString('hex');

class TestOrderStore {
  constructor() {
    this.orders = [];
    this.nextId = 1;
  }

  async initialize() {}

  async listOrders() {
    return [...this.orders].sort((a, b) => b.id - a.id).map((order) => ({ ...order }));
  }

  async createOrder(order) {
    const id = this.nextId++;
    this.orders.push({
      id,
      customer_name: order.customerName,
      email: order.email,
      phone: order.phone,
      address: order.address,
      product: order.product,
      size: order.size,
      quantity: order.quantity,
      total: order.total,
      status: order.status,
      created_at: new Date().toISOString(),
    });
    return id;
  }

  async createOrders(orders) {
    const ids = [];
    for (const order of orders) {
      ids.push(await this.createOrder(order));
    }
    return ids;
  }

  async deleteOrderById(id) {
    this.orders = this.orders.filter((order) => order.id !== Number(id));
  }

  async updateOrderStatus(id, status) {
    const order = this.orders.find((item) => item.id === Number(id));
    if (order) {
      order.status = status;
    }
  }

  async updatePendingOrder(id, updates) {
    const order = this.orders.find((item) => item.id === Number(id));
    if (!order || order.status !== 'Pending Confirmation') return false;
    Object.assign(order, updates);
    return true;
  }
}

class TestSessionStore {
  constructor() {
    this.sessions = new Map();
  }

  async initialize() {}

  async get(id) {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session.data;
  }

  async set(id, data, expiresAt) {
    this.sessions.set(id, { data, expiresAt });
  }

  async destroy(id) {
    this.sessions.delete(id);
  }
}

test.before(async () => {
  orderStore = new TestOrderStore();
  sessionStore = new TestSessionStore();
  server = await startServer(
    0,
    '127.0.0.1',
    createApp(orderStore, {
      adminUsername: testAdminUsername,
      adminPassword: testAdminPassword,
      sessionStore,
    })
  );

  const response = await fetch(`http://localhost:${server.address().port}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: testAdminUsername, password: testAdminPassword }),
  });
  assert.equal(response.status, 200);
  adminCookie = response.headers.get('set-cookie').split(';')[0];
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function withAdminAuth(options = {}) {
  return {
    ...options,
    headers: {
      ...options.headers,
      Cookie: adminCookie,
    },
  };
}

async function submitOrder(payload) {
  return fetch(`http://localhost:${server.address().port}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('admin login accepts valid credentials and returns only an opaque session cookie', async () => {
  const port = server.address().port;
  const response = await fetch(`http://localhost:${port}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: testAdminUsername, password: testAdminPassword }),
  });
  const result = await response.json();
  const setCookie = response.headers.get('set-cookie');

  assert.equal(response.status, 200);
  assert.deepEqual(result, { ok: true });
  assert.match(setCookie, /^jerzee_admin_session=[A-Za-z0-9_-]+;/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.equal(JSON.stringify(result).includes(testAdminUsername), false);
  assert.equal(JSON.stringify(result).includes(testAdminPassword), false);
  assert.notEqual(setCookie.split(';')[0], adminCookie);
});

test('admin login rejects invalid credentials without creating a session', async () => {
  const response = await fetch(`http://localhost:${server.address().port}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: testAdminUsername, password: wrongPassword }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Invalid username or password.' });
  assert.equal(response.headers.get('set-cookie'), null);
});

test('admin session cookies are marked Secure in production', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const response = await fetch(`http://localhost:${server.address().port}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testAdminUsername, password: testAdminPassword }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /; Secure(?:;|$)/);
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
});

test('admin portal and order management require authentication', async () => {
  const port = server.address().port;

  const portalResponse = await fetch(`http://localhost:${port}/staff`, { redirect: 'manual' });
  assert.equal(portalResponse.status, 302);
  assert.equal(portalResponse.headers.get('location'), '/admin/login');

  const oldPortalResponse = await fetch(`http://localhost:${port}/admin.html`, { redirect: 'manual' });
  assert.equal(oldPortalResponse.status, 302);

  const ordersResponse = await fetch(`http://localhost:${port}/api/orders`);
  assert.equal(ordersResponse.status, 401);

  for (const [url, method] of [
    ['/api/orders', 'PATCH'],
    ['/api/orders/1/quantity', 'PATCH'],
    ['/api/orders/1/confirm', 'PATCH'],
    ['/api/orders/1/cancel', 'PATCH'],
    ['/api/orders/1', 'PATCH'],
    ['/api/orders/1', 'DELETE'],
  ]) {
    const response = await fetch(`http://localhost:${port}${url}`, { method });
    assert.equal(response.status, 401, `${method} ${url} should require a session`);
  }

  const authenticatedPortalResponse = await fetch(`http://localhost:${port}/staff`, withAdminAuth());
  assert.equal(authenticatedPortalResponse.status, 200);
  assert.match(await authenticatedPortalResponse.text(), /JERZEE Operations/);
});

test('logout destroys the server session and expires its cookie', async () => {
  const port = server.address().port;
  const loginResponse = await fetch(`http://localhost:${port}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: testAdminUsername, password: testAdminPassword }),
  });
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const logoutResponse = await fetch(`http://localhost:${port}/admin/logout`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });

  assert.equal(logoutResponse.status, 200);
  assert.match(logoutResponse.headers.get('set-cookie'), /Max-Age=0/);
  const protectedResponse = await fetch(`http://localhost:${port}/api/orders`, {
    headers: { Cookie: cookie },
  });
  assert.equal(protectedResponse.status, 401);
});

test('expired admin sessions no longer authorize protected routes', async () => {
  const expiredSessionStore = new TestSessionStore();
  const expiredServer = await startServer(0, '127.0.0.1', createApp(new TestOrderStore(), {
    adminUsername: testAdminUsername,
    adminPassword: testAdminPassword,
    sessionStore: expiredSessionStore,
    sessionDurationMs: 20,
  }));

  try {
    const loginResponse = await fetch(`http://localhost:${expiredServer.address().port}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testAdminUsername, password: testAdminPassword }),
    });
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
    await new Promise((resolve) => setTimeout(resolve, 30));
    const protectedResponse = await fetch(`http://localhost:${expiredServer.address().port}/api/orders`, {
      headers: { Cookie: cookie },
    });
    assert.equal(protectedResponse.status, 401);
  } finally {
    await new Promise((resolve, reject) => expiredServer.close((error) =>
      error ? reject(error) : resolve()
    ));
  }
});

test('admin login rate limiting rejects attempts after the configured threshold', async () => {
  const limitedServer = await startServer(0, '127.0.0.1', createApp(new TestOrderStore(), {
    adminUsername: testAdminUsername,
    adminPassword: testAdminPassword,
    sessionStore: new TestSessionStore(),
    loginRateLimit: { maxAttempts: 2, windowMs: 60000 },
  }));

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`http://localhost:${limitedServer.address().port}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: randomBytes(8).toString('hex'), password: wrongPassword }),
      });
      assert.equal(response.status, 401);
    }
    const limitedResponse = await fetch(`http://localhost:${limitedServer.address().port}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testAdminUsername, password: testAdminPassword }),
    });
    assert.equal(limitedResponse.status, 429);
    assert.ok(Number(limitedResponse.headers.get('retry-after')) > 0);
  } finally {
    await new Promise((resolve, reject) => limitedServer.close((error) =>
      error ? reject(error) : resolve()
    ));
  }
});

test('required environment validation reports missing variable names without values', () => {
  const privateServiceKey = randomBytes(32).toString('hex');
  assert.throws(
    () => validateEnvironment({
      SUPABASE_URL: 'https://example-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: privateServiceKey,
      ADMIN_USERNAME: testAdminUsername,
    }),
    (error) => {
      assert.match(error.message, /ADMIN_PASSWORD/);
      assert.equal(error.message.includes(privateServiceKey), false);
      assert.equal(error.message.includes(testAdminUsername), false);
      return true;
    }
  );
});

test('public responses never include admin credentials or Supabase service-role secrets', async () => {
  const response = await fetch(`http://localhost:${server.address().port}/api/products`);
  const responseText = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(responseText, /SUPABASE_SERVICE_ROLE_KEY|ADMIN_PASSWORD/);
  assert.equal(responseText.includes(testAdminPassword), false);
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    assert.equal(responseText.includes(process.env.SUPABASE_SERVICE_ROLE_KEY), false);
  }
});

test('order total is calculated from the trusted product price and quantity', async () => {
  for (const [email, quantity, expectedTotal] of [
    ['price-check-one@example.com', 1, 1199],
    ['price-check-two@example.com', 2, 2398],
  ]) {
    const response = await submitOrder({
      customerName: 'Price Check',
      email,
      phone: '123456789',
      address: 'Price Street',
      product_id: 'barcelona-home-2026',
      size: 'M',
      quantity,
    });

    assert.equal(response.status, 201);
    const order = orderStore.orders.find((item) => item.email === email);
    assert.equal(order.total, expectedTotal);
    assert.equal(order.quantity, quantity);
  }
});

test('client-supplied low and high totals are ignored', async () => {
  for (const [email, total] of [
    ['low-fake-total@example.com', 1],
    ['high-fake-total@example.com', 999999],
  ]) {
    const response = await submitOrder({
      customerName: 'Manipulated Total',
      email,
      phone: '123456789',
      address: 'Price Street',
      product_id: 'barcelona-home-2026',
      size: 'M',
      quantity: 2,
      total,
    });

    assert.equal(response.status, 201);
    const order = orderStore.orders.find((item) => item.email === email);
    assert.equal(order.total, 2398);
    assert.notEqual(order.total, total);
  }
});

test('orders reject unknown products without creating an order', async () => {
  const response = await submitOrder({
    customerName: 'Unknown Product',
    email: 'unknown-product@example.com',
    phone: '123456789',
    address: 'Price Street',
    product_id: 'not-a-real-product',
    size: 'M',
    quantity: 1,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid product' });
  assert.ok(!orderStore.orders.some((item) => item.email === 'unknown-product@example.com'));
});

test('orders reject non-positive, non-integer, and non-numeric quantities', async () => {
  const invalidQuantities = [0, -1, -5, 'abc', null, 1.5, undefined];

  for (const [index, quantity] of invalidQuantities.entries()) {
    const email = `invalid-quantity-${index}@example.com`;
    const response = await submitOrder({
      customerName: 'Invalid Quantity',
      email,
      phone: '123456789',
      address: 'Price Street',
      product_id: 'barcelona-home-2026',
      size: 'M',
      quantity,
    });

    assert.equal(response.status, 400, `quantity ${String(quantity)} should be rejected`);
    assert.ok(!orderStore.orders.some((item) => item.email === email));
  }
});

test('orders reject sizes not supported by the selected product', async () => {
  const response = await submitOrder({
    customerName: 'Invalid Size',
    email: 'invalid-size@example.com',
    phone: '123456789',
    address: 'Price Street',
    product_id: 'barcelona-home-2026',
    size: 'XXXXXXXL',
    quantity: 1,
  });

  assert.equal(response.status, 400);
  assert.ok(!orderStore.orders.some((item) => item.email === 'invalid-size@example.com'));
});

test('customer can place an order and admin can view it', async () => {
  const port = server.address().port;
  const payload = {
    customerName: 'Test User',
    email: 'customer@example.com',
    phone: '123456789',
    address: 'Test Street 42',
    product_id: 'barcelona-home-2026',
    size: 'L',
    quantity: 2,
  };

  const postResponse = await fetch(`http://localhost:${port}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  assert.equal(postResponse.status, 201);
  const postBody = await postResponse.json();
  assert.ok(postBody.orderId > 0);

  const getResponse = await fetch(`http://localhost:${port}/api/orders`, withAdminAuth());
  assert.equal(getResponse.status, 200);
  const orders = await getResponse.json();
  assert.ok(Array.isArray(orders));
  assert.ok(orders.some((order) =>
    order.customer_name === 'Test User' &&
    order.email === 'customer@example.com' &&
    order.product === 'FC Barcelona 2026 home Jersey' &&
    order.total === 2398 &&
    order.status === 'Pending Confirmation'
  ));
});

test('customer can place every item in the cart in one order request', async () => {
  const port = server.address().port;
  const response = await fetch(`http://localhost:${port}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'Cart Customer',
      email: 'cart@example.com',
      phone: '123456789',
      address: 'Cart Street 42',
      items: [
        { product_id: 'barcelona-home-2026', size: 'M', quantity: 2 },
        { product_id: 'ferrari-racing-2026', size: 'L', quantity: 1 },
      ],
    }),
  });

  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.orderIds.length, 2);

  const ordersResponse = await fetch(`http://localhost:${port}/api/orders`, withAdminAuth());
  const orders = await ordersResponse.json();
  const cartOrders = orders.filter((order) => order.email === 'cart@example.com');
  assert.equal(cartOrders.length, 2);
  assert.deepEqual(
    cartOrders.map(({ product, size, quantity, total }) => ({ product, size, quantity, total })),
    [
      { product: 'Scuderia Ferrari F1 Team Jersey 2026', size: 'L', quantity: 1, total: 1350 },
      { product: 'FC Barcelona 2026 home Jersey', size: 'M', quantity: 2, total: 2398 },
    ]
  );
});

test('cart checkout rejects the entire request if any item is invalid', async () => {
  const port = server.address().port;
  const response = await fetch(`http://localhost:${port}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'Invalid Cart',
      email: 'invalid-cart@example.com',
      phone: '123456789',
      address: 'Cart Street 42',
      items: [
        { product_id: 'barcelona-home-2026', size: 'M', quantity: 1 },
        { product_id: '', size: 'L', quantity: 1 },
      ],
    }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /every item/i);

  const ordersResponse = await fetch(`http://localhost:${port}/api/orders`, withAdminAuth());
  const orders = await ordersResponse.json();
  assert.ok(!orders.some((order) => order.email === 'invalid-cart@example.com'));
});

test('invalid order data is rejected', async () => {
  const port = server.address().port;

  const response = await fetch(`http://localhost:${port}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: '',
      email: 'customer@example.com',
      phone: '123',
      address: 'x',
      product_id: 'barcelona-home-2026',
      size: 'M',
      quantity: 1,
    }),
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /all order fields|valid/i);
});

test('orders require an email address', async () => {
  const port = server.address().port;

  const response = await fetch(`http://localhost:${port}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'Missing Email',
      phone: '123456789',
      address: 'Test Street 42',
      product_id: 'barcelona-home-2026',
      size: 'L',
      quantity: 1,
    }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid email address/i);
});

test('orders reject invalid email addresses', async () => {
  const port = server.address().port;

  const response = await fetch(`http://localhost:${port}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'Invalid Email',
      email: 'invalid-email',
      phone: '123456789',
      address: 'Test Street 42',
      product_id: 'barcelona-home-2026',
      size: 'L',
      quantity: 1,
    }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid email address/i);
});

test('pending orders can be edited by authenticated staff and totals are recalculated', async () => {
  const port = server.address().port;
  const createResponse = await submitOrder({
    customerName: 'Edit Me',
    email: 'edit@example.com',
    phone: '999',
    address: 'Edit Street',
    product_id: 'barcelona-home-2026',
    size: 'M',
    quantity: 2,
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  const editResponse = await fetch(`http://localhost:${port}/api/orders/${created.orderId}/quantity`, withAdminAuth({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity: 1, total: 1 }),
  }));
  assert.equal(editResponse.status, 200);
  assert.deepEqual(await editResponse.json(), {
    message: 'Order quantity updated.',
    quantity: 1,
    total: 1199,
  });
  const savedOrder = orderStore.orders.find((order) => order.id === created.orderId);
  assert.equal(savedOrder.quantity, 1);
  assert.equal(savedOrder.total, 1199);
});

test('pending order edit validates order ID and quantity', async () => {
  const createResponse = await submitOrder({
    customerName: 'Invalid Edit',
    email: 'invalid-edit@example.com',
    phone: '999',
    address: 'Edit Street',
    product_id: 'barcelona-home-2026',
    size: 'M',
    quantity: 2,
  });
  const created = await createResponse.json();
  const port = server.address().port;

  const invalidIdResponse = await fetch(`http://localhost:${port}/api/orders/not-an-id/quantity`, withAdminAuth({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity: 1 }),
  }));
  assert.equal(invalidIdResponse.status, 400);

  for (const quantity of [0, -1, 'abc', 1.5, 2147483648]) {
    const response = await fetch(`http://localhost:${port}/api/orders/${created.orderId}/quantity`, withAdminAuth({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity }),
    }));
    assert.equal(response.status, 400);
  }

  const savedOrder = orderStore.orders.find((order) => order.id === created.orderId);
  assert.equal(savedOrder.quantity, 2);
  assert.equal(savedOrder.total, 2398);
});

test('pending order editing and confirmation actions require admin authentication', async () => {
  const createResponse = await submitOrder({
    customerName: 'Auth Check',
    email: 'auth-check@example.com',
    phone: '999',
    address: 'Auth Street',
    product_id: 'barcelona-home-2026',
    size: 'M',
    quantity: 1,
  });
  const created = await createResponse.json();
  const port = server.address().port;

  for (const action of ['quantity', 'confirm', 'cancel']) {
    const response = await fetch(`http://localhost:${port}/api/orders/${created.orderId}/${action}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: 2 }),
    });
    assert.equal(response.status, 401);
  }
});

test('pending orders can be confirmed with a server-calculated edited quantity', async () => {
  const createResponse = await submitOrder({
    customerName: 'Confirm Me',
    email: 'confirm@example.com',
    phone: '999',
    address: 'Confirm Street',
    product_id: 'barcelona-home-2026',
    size: 'M',
    quantity: 1,
  });
  const created = await createResponse.json();
  const port = server.address().port;
  const response = await fetch(`http://localhost:${port}/api/orders/${created.orderId}/confirm`, withAdminAuth({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity: 2, total: 1 }),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    message: 'Order confirmed.',
    quantity: 2,
    total: 2398,
    status: 'Confirmed',
  });
  const savedOrder = orderStore.orders.find((order) => order.id === created.orderId);
  assert.equal(savedOrder.status, 'Confirmed');
  assert.equal(savedOrder.quantity, 2);
  assert.equal(savedOrder.total, 2398);

  const editResponse = await fetch(`http://localhost:${port}/api/orders/${created.orderId}/quantity`, withAdminAuth({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity: 1 }),
  }));
  assert.equal(editResponse.status, 409);
});

test('pending orders can be cancelled without deleting them', async () => {
  const createResponse = await submitOrder({
    customerName: 'Cancel Me',
    email: 'cancel@example.com',
    phone: '999',
    address: 'Cancelled Street',
    product_id: 'barcelona-home-2026',
    size: 'M',
    quantity: 1,
  });
  const created = await createResponse.json();
  const port = server.address().port;
  const response = await fetch(`http://localhost:${port}/api/orders/${created.orderId}/cancel`, withAdminAuth({
    method: 'PATCH',
  }));
  assert.equal(response.status, 200);

  const listResponse = await fetch(`http://localhost:${port}/api/orders`, withAdminAuth());
  assert.equal(listResponse.status, 200);
  const refreshedOrders = await listResponse.json();
  const cancelledOrder = refreshedOrders.find((order) => order.id === created.orderId);
  assert.ok(cancelledOrder);
  assert.equal(cancelledOrder.status, 'Cancelled');

  const editResponse = await fetch(`http://localhost:${port}/api/orders/${created.orderId}/quantity`, withAdminAuth({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity: 2 }),
  }));
  assert.equal(editResponse.status, 409);
});

test('delete endpoint permanently removes an order from storage', async () => {
  const port = server.address().port;

  const createResponse = await fetch(`http://localhost:${port}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'Delete Me',
      email: 'delete@example.com',
      phone: '555',
      address: 'Delete Street',
      product_id: 'ferrari-racing-2026',
      size: 'XL',
      quantity: 1,
    }),
  });

  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  const deleteResponse = await fetch(`http://localhost:${port}/api/orders/${created.orderId}`, withAdminAuth({
    method: 'DELETE',
  }));

  assert.equal(deleteResponse.status, 200);

  const listResponse = await fetch(`http://localhost:${port}/api/orders`, withAdminAuth());
  assert.equal(listResponse.status, 200);

  const refreshedOrders = await listResponse.json();
  assert.ok(!refreshedOrders.some((order) => order.id === created.orderId));
});

test('pending orders cannot bypass confirmation using the generic status endpoint', async () => {
  const port = server.address().port;

  const createResponse = await fetch(`http://localhost:${port}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'Lowercase Status',
      email: 'status@example.com',
      phone: '777',
      address: 'Lowercase Street',
      product_id: 'barcelona-home-2026',
      size: 'M',
      quantity: 1,
    }),
  });

  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  const patchResponse = await fetch(`http://localhost:${port}/api/orders/${created.orderId}`, withAdminAuth({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'confirmed' }),
  }));

  assert.equal(patchResponse.status, 409);

  const listResponse = await fetch(`http://localhost:${port}/api/orders`, withAdminAuth());
  assert.equal(listResponse.status, 200);
  const refreshedOrders = await listResponse.json();
  assert.equal(refreshedOrders.find((order) => order.id === created.orderId).status, 'Pending Confirmation');
});

test('products endpoint returns available jerseys and supports search & sport filtering', async () => {
  const port = server.address().port;

  const response = await fetch(`http://localhost:${port}/api/products`);
  assert.equal(response.status, 200);
  const products = await response.json();
  assert.ok(Array.isArray(products));
  assert.ok(products.length >= 4);

  // Validate no basketball or tennis products exist
  assert.ok(!products.some((p) => /basketball|tennis/i.test(p.sport || '')));

  // Test sport filtering
  const footballResponse = await fetch(`http://localhost:${port}/api/products?sport=football`);
  const footballProducts = await footballResponse.json();
  assert.ok(footballProducts.length > 0);
  assert.ok(footballProducts.every((p) => p.sportKey === 'football' || p.sport.toLowerCase() === 'football'));

  // Test search query
  const searchResponse = await fetch(`http://localhost:${port}/api/products?q=barcelona`);
  const searchProducts = await searchResponse.json();
  assert.ok(searchProducts.length > 0);
  assert.ok(searchProducts.some((p) => p.name.includes('Barcelona')));
});
