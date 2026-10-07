const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, startServer } = require('../server');

let server;
let orderStore;

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

test.before(async () => {
  orderStore = new TestOrderStore();
  server = await startServer(
    0,
    '127.0.0.1',
    createApp(orderStore, { adminUsername: 'test-admin', adminPassword: 'test-password' })
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

async function submitOrder(payload) {
  return fetch(`http://localhost:${server.address().port}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
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
