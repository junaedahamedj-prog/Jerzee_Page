const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, startServer } = require('../server');

let server;

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
      status: 'Pending',
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

  async clearCancelledOrders() {
    this.orders = this.orders.filter(
      (order) => String(order.status).toLowerCase() !== 'cancelled'
    );
  }

  async updateOrderStatus(id, status) {
    const order = this.orders.find((item) => item.id === Number(id));
    if (order) {
      order.status = status;
    }
  }
}

test.before(async () => {
  server = await startServer(
    0,
    '127.0.0.1',
    createApp(new TestOrderStore(), { adminUsername: 'test-admin', adminPassword: 'test-password' })
  );
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
      Authorization: `Basic ${Buffer.from('test-admin:test-password').toString('base64')}`,
    },
  };
}

test('admin portal and order management require authentication', async () => {
  const port = server.address().port;

  const portalResponse = await fetch(`http://localhost:${port}/staff`);
  assert.equal(portalResponse.status, 401);
  assert.match(portalResponse.headers.get('www-authenticate'), /Basic/);

  const oldPortalResponse = await fetch(`http://localhost:${port}/admin.html`);
  assert.equal(oldPortalResponse.status, 401);

  const ordersResponse = await fetch(`http://localhost:${port}/api/orders`);
  assert.equal(ordersResponse.status, 401);

  const deleteResponse = await fetch(`http://localhost:${port}/api/orders/1`, {
    method: 'DELETE',
  });
  assert.equal(deleteResponse.status, 401);

  const authenticatedPortalResponse = await fetch(
    `http://localhost:${port}/staff`,
    withAdminAuth()
  );
  assert.equal(authenticatedPortalResponse.status, 200);
  assert.match(await authenticatedPortalResponse.text(), /JERZEE Operations/);
});

test('customer can place an order and admin can view it', async () => {
  const port = server.address().port;
  const payload = {
    customerName: 'Test User',
    email: 'customer@example.com',
    phone: '123456789',
    address: 'Test Street 42',
    product: 'Barcelona Inspired Jersey',
    size: 'L',
    quantity: 2,
    total: 2400,
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
    order.product === 'Barcelona Inspired Jersey'
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
        { product: 'Barcelona Jersey', size: 'M', quantity: 2, total: 2400 },
        { product: 'Ferrari Jersey', size: 'L', quantity: 1, total: 1350 },
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
      { product: 'Ferrari Jersey', size: 'L', quantity: 1, total: 1350 },
      { product: 'Barcelona Jersey', size: 'M', quantity: 2, total: 2400 },
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
        { product: 'Valid Jersey', size: 'M', quantity: 1, total: 1200 },
        { product: '', size: 'L', quantity: 1, total: 1200 },
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
      product: 'Test Item',
      size: 'M',
      quantity: 1,
      total: 0,
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
      product: 'Barcelona Inspired Jersey',
      size: 'L',
      quantity: 1,
      total: 1200,
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
      product: 'Barcelona Inspired Jersey',
      size: 'L',
      quantity: 1,
      total: 1200,
    }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid email address/i);
});

test('cancelled orders are removed immediately and on refresh', async () => {
  const port = server.address().port;

  const createResponse = await fetch(`http://localhost:${port}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'Cancel Me',
      email: 'cancel@example.com',
      phone: '999',
      address: 'Cancelled Street',
      product: 'Cancelled Jersey',
      size: 'M',
      quantity: 1,
      total: 1000,
    }),
  });

  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  const patchResponse = await fetch(`http://localhost:${port}/api/orders/${created.orderId}`, withAdminAuth({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Cancelled' }),
  }));

  assert.equal(patchResponse.status, 200);

  const listResponse = await fetch(`http://localhost:${port}/api/orders`, withAdminAuth());
  assert.equal(listResponse.status, 200);

  const refreshedOrders = await listResponse.json();
  assert.ok(!refreshedOrders.some((order) => order.id === created.orderId));
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
      product: 'Delete Jersey',
      size: 'XL',
      quantity: 1,
      total: 1500,
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

test('status updates accept case-insensitive values and remove cancelled orders', async () => {
  const port = server.address().port;

  const createResponse = await fetch(`http://localhost:${port}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'Lowercase Status',
      email: 'status@example.com',
      phone: '777',
      address: 'Lowercase Street',
      product: 'Lowercase Jersey',
      size: 'M',
      quantity: 1,
      total: 1200,
    }),
  });

  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  const patchResponse = await fetch(`http://localhost:${port}/api/orders/${created.orderId}`, withAdminAuth({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'cancelled' }),
  }));

  assert.equal(patchResponse.status, 200);

  const listResponse = await fetch(`http://localhost:${port}/api/orders`, withAdminAuth());
  assert.equal(listResponse.status, 200);
  const refreshedOrders = await listResponse.json();
  assert.ok(!refreshedOrders.some((order) => order.id === created.orderId));
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
