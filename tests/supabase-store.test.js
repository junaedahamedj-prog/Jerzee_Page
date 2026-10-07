const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SupabaseOrdersStore } = require('../supabase-orders-store');

let remoteServer;
let store;
let orders;
let requests;
let nextId;

test.before(async () => {
  orders = [{ id: 45, status: 'Cancelled' }];
  requests = [];
  nextId = 46;
  remoteServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const query = url.searchParams;
    requests.push({ method: req.method, url, apiKey: req.headers.apikey });

    const respond = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/rest/v1/orders' && req.method === 'GET') {
      if (query.get('select') === 'id') {
        return respond(200, []);
      }
      const offset = Number(query.get('offset') || 0);
      const limit = Number(query.get('limit') || 1000);
      const rows = [...orders].sort((a, b) => b.id - a.id).slice(offset, offset + limit);
      return respond(200, rows);
    }

    if (url.pathname === '/rest/v1/orders' && req.method === 'POST') {
      let rawBody = '';
      for await (const chunk of req) {
        rawBody += chunk;
      }
      const values = JSON.parse(rawBody);
      const inserted = (Array.isArray(values) ? values : [values]).map((value) => {
        const order = { id: nextId++, status: 'Pending Confirmation', ...value };
        orders.push(order);
        return order;
      });
      return respond(201, req.headers.prefer?.includes('return=representation') ? inserted : []);
    }

    if (url.pathname === '/rest/v1/orders' && req.method === 'PATCH') {
      let rawBody = '';
      for await (const chunk of req) {
        rawBody += chunk;
      }
      const values = JSON.parse(rawBody);
      const id = Number(query.get('id')?.replace('eq.', ''));
      const status = query.get('status')?.replace('eq.', '');
      let updated = false;
      orders.forEach((order) => {
        if (order.id === id && (!status || order.status === status)) {
          Object.assign(order, values);
          updated = true;
        }
      });
      if (req.headers.prefer?.includes('return=representation')) {
        return respond(200, updated ? [{ id }] : []);
      }
      return respond(204, null);
    }

    if (url.pathname === '/rest/v1/orders' && req.method === 'DELETE') {
      if (query.get('status') === 'ilike.cancelled') {
        orders = orders.filter((order) => order.status.toLowerCase() !== 'cancelled');
      } else {
        const id = Number(query.get('id')?.replace('eq.', ''));
        orders = orders.filter((order) => order.id !== id);
      }
      return respond(204, null);
    }

    return respond(404, { message: 'Unexpected REST request' });
  });

  await new Promise((resolve) => remoteServer.listen(0, '127.0.0.1', resolve));
  process.env.SUPABASE_URL = `http://127.0.0.1:${remoteServer.address().port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  store = new SupabaseOrdersStore();
  await store.initialize();
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    remoteServer.close((error) => (error ? reject(error) : resolve()));
  });
});

test('Supabase REST store supports order creation, listing, status updates, and deletion', async () => {
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, 'Cancelled');
  const orderId = await store.createOrder({
    customerName: 'Supabase Test',
    email: 'customer@example.com',
    phone: '123456789',
    address: 'Test Street',
    product: 'Jersey',
    size: 'M',
    quantity: 1,
    total: 1200,
  });

  assert.equal(orderId, 46);
  assert.equal((await store.listOrders())[0].email, 'customer@example.com');

  const pending = await store.listOrders().then((items) => items.find((order) => order.id === orderId));
  assert.equal(pending.status, 'Pending Confirmation');
  assert.equal(await store.updatePendingOrder(orderId, { quantity: 2, total: 2400 }), true);
  assert.equal(await store.updatePendingOrder(orderId, { status: 'Confirmed' }), true);
  assert.equal(await store.updatePendingOrder(orderId, { quantity: 3 }), false);
  assert.equal((await store.listOrders()).find((order) => order.id === orderId).total, 2400);

  await store.updateOrderStatus(orderId, 'Shipped');
  assert.equal((await store.listOrders())[0].status, 'Shipped');

  await store.deleteOrderById(orderId);
  assert.deepEqual(await store.listOrders(), [{ id: 45, status: 'Cancelled' }]);
  assert.ok(requests.every((request) => request.apiKey === 'test-service-role-key'));
});

test('Supabase REST store creates multiple cart orders in one insert', async () => {
  const postRequestCount = requests.filter(
    (request) => request.method === 'POST' && request.url.pathname === '/rest/v1/orders'
  ).length;
  const orderIds = await store.createOrders([
    {
      customerName: 'Cart Customer',
      email: 'cart@example.com',
      phone: '123456789',
      address: 'Cart Street',
      product: 'Barcelona Jersey',
      size: 'M',
      quantity: 2,
      total: 2400,
    },
    {
      customerName: 'Cart Customer',
      email: 'cart@example.com',
      phone: '123456789',
      address: 'Cart Street',
      product: 'Ferrari Jersey',
      size: 'L',
      quantity: 1,
      total: 1350,
    },
  ]);

  assert.deepEqual(orderIds, [47, 48]);
  assert.equal(
    orders.filter((order) => order.email === 'cart@example.com').length,
    2
  );
  const insertRequests = requests.filter(
    (request) => request.method === 'POST' && request.url.pathname === '/rest/v1/orders'
  );
  assert.equal(insertRequests.length, postRequestCount + 1);
  assert.ok(orders.filter((order) => order.email === 'cart@example.com')
    .every((order) => order.status === 'Pending Confirmation'));
});
