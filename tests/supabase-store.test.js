const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { SupabaseOrdersStore } = require('../supabase-orders-store');

let remoteServer;
let store;
let orders;
let requests;
let requestBodies;
let productRows;
let nextId;
let inventoryFailuresRemaining;
const testServiceRoleKey = randomBytes(32).toString('hex');

test.before(async () => {
  orders = [{ id: 45, status: 'Cancelled' }];
  requests = [];
  requestBodies = [];
  productRows = [];
  nextId = 46;
  inventoryFailuresRemaining = 0;
  remoteServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const query = url.searchParams;
    requests.push({ method: req.method, url, apiKey: req.headers.apikey });

    const respond = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.startsWith('/storage/v1/object/product-images/') &&
        req.method === 'POST') {
      let uploaded = Buffer.alloc(0);
      for await (const chunk of req) {
        uploaded = Buffer.concat([uploaded, chunk]);
      }
      return respond(200, { uploadedBytes: uploaded.length });
    }

    if (url.pathname === '/storage/v1/object/product-images' &&
        req.method === 'DELETE') {
      let rawBody = '';
      for await (const chunk of req) {
        rawBody += chunk;
      }
      requestBodies.push({ resource: url.pathname.slice('/storage/v1/'.length), body: JSON.parse(rawBody) });
      return respond(200, {});
    }

    if (url.pathname === '/rest/v1/orders' && req.method === 'GET') {
      if (query.get('select') === 'id') {
        return respond(200, []);
      }
      const id = query.get('id')?.replace('eq.', '');
      if (id) {
        return respond(200, orders.filter((order) => Number(order.id) === Number(id)).slice(0, 1));
      }
      const offset = Number(query.get('offset') || 0);
      const limit = Number(query.get('limit') || 1000);
      const rows = [...orders].sort((a, b) => b.id - a.id).slice(offset, offset + limit);
      return respond(200, rows);
    }

    if (url.pathname === '/rest/v1/inventory_stock' && req.method === 'GET') {
      if (inventoryFailuresRemaining > 0) {
        inventoryFailuresRemaining -= 1;
        return respond(503, { message: 'Temporary Supabase failure' });
      }
      return respond(200, [{
        product_id: 'barcelona-home-2026',
        size: 'M',
        available_quantity: 4,
        low_stock_threshold: 5,
      }]);
    }

    if (url.pathname.startsWith('/rest/v1/rpc/') && req.method === 'POST') {
      let rawBody = '';
      for await (const chunk of req) {
        rawBody += chunk;
      }
      const body = JSON.parse(rawBody);
      requestBodies.push({ resource: url.pathname.slice('/rest/v1/'.length), body });
      if (url.pathname.endsWith('/create_product_with_inventory')) {
        productRows.push({
          ...body.p_product,
          sport_key: body.p_product.sport_key,
        });
        return respond(200, productRows[productRows.length - 1]);
      }
      if (url.pathname.endsWith('/create_inventory_orders')) {
        return respond(200, { orderIds: [201, 202] });
      }
      if (url.pathname.endsWith('/update_pending_inventory_order')) {
        return respond(200, { updated: true });
      }
      if (url.pathname.endsWith('/cancel_pending_inventory_order')) {
        return respond(200, { updated: true });
      }
      if (url.pathname.endsWith('/set_inventory_stock')) {
        return respond(200, {
          product_id: body.p_product_id,
          size: body.p_size,
          available_quantity: body.p_quantity,
          low_stock_threshold: 5,
        });
      }
    }

    if (url.pathname === '/rest/v1/products' && req.method === 'GET') {
      return respond(200, productRows);
    }

    if (url.pathname === '/rest/v1/products' && req.method === 'PATCH') {
      let rawBody = '';
      for await (const chunk of req) {
        rawBody += chunk;
      }
      const values = JSON.parse(rawBody);
      const id = query.get('id')?.replace('eq.', '');
      const product = productRows.find((item) => item.id === id);
      if (product) Object.assign(product, values);
      return respond(200, product ? [{ id }] : []);
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
  process.env.SUPABASE_SERVICE_ROLE_KEY = testServiceRoleKey;
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
  assert.ok(requests.every((request) => request.apiKey === testServiceRoleKey));
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

test('Supabase order lookup fetches only the requested order', async () => {
  orders.push({
    id: 91,
    status: 'Confirmed',
    customer_name: 'Lookup Customer',
    product: 'Jersey',
  });
  const requestCount = requests.length;
  const order = await store.getOrderById(91);
  const lookupRequests = requests.slice(requestCount);

  assert.equal(order.id, 91);
  assert.equal(lookupRequests.length, 1);
  assert.equal(lookupRequests[0].method, 'GET');
  assert.equal(lookupRequests[0].url.searchParams.get('id'), 'eq.91');
  assert.equal(lookupRequests[0].url.searchParams.get('limit'), '1');
  assert.equal(await store.getOrderById(999), null);
});

test('Supabase inventory adapter reads stock and calls inventory transaction RPCs', async () => {
  const inventory = await store.listInventory();
  assert.equal(inventory[0].available_quantity, 4);

  const stock = await store.setInventoryStock('barcelona-home-2026', 'M', 9);
  assert.equal(stock.available_quantity, 9);

  const orderIds = await store.createInventoryOrders({
    customerName: 'Inventory Customer',
    email: 'inventory@example.com',
    phone: '123456789',
    address: 'Inventory Street',
  }, [{
    productId: 'barcelona-home-2026',
    product: 'Barcelona Jersey',
    size: 'M',
    quantity: 2,
    total: 2398,
  }]);
  assert.deepEqual(orderIds, [201, 202]);

  assert.deepEqual(await store.updatePendingInventoryOrder(
    12,
    { quantity: 3, total: 3597, status: 'Confirmed' },
    'barcelona-home-2026'
  ), { updated: true });
  assert.deepEqual(await store.cancelPendingInventoryOrder(12), { updated: true });

  const calls = requestBodies.slice(-4);
  assert.deepEqual(calls.map((call) => call.resource), [
    'rpc/set_inventory_stock',
    'rpc/create_inventory_orders',
    'rpc/update_pending_inventory_order',
    'rpc/cancel_pending_inventory_order',
  ]);
  assert.deepEqual(calls[0].body, {
    p_product_id: 'barcelona-home-2026',
    p_size: 'M',
    p_quantity: 9,
  });
  assert.deepEqual(calls[2].body, {
    p_order_id: 12,
    p_quantity: 3,
    p_total: 3597,
    p_product_id: 'barcelona-home-2026',
    p_target_status: 'Confirmed',
  });
  assert.deepEqual(calls[3].body, { p_order_id: 12 });
});

test('Supabase inventory reads retry a transient server failure', async () => {
  inventoryFailuresRemaining = 1;
  const requestCount = requests.length;

  const inventory = await store.listInventory();

  assert.equal(inventory[0].available_quantity, 4);
  assert.equal(requests.length - requestCount, 2);
});

test('Supabase product creation uses the atomic inventory RPC and edits leave sizes untouched', async () => {
  const product = {
    id: 'new-jersey-id',
    name: 'New Jersey',
    sport: 'Football',
    sportKey: 'football',
    price: 1600,
    image: 'https://images.example/new-jersey.jpg',
    badge: '',
    description: 'A new jersey.',
    featured: false,
    active: true,
    sizes: ['M'],
  };
  await store.createProduct(product, { M: 3 });

  const createCall = requestBodies.find(
    (call) => call.resource === 'rpc/create_product_with_inventory'
  );
  assert.equal(createCall.body.p_product.id, product.id);
  assert.deepEqual(createCall.body.p_inventory, [{ size: 'M', quantity: 3 }]);

  const loaded = await store.listProducts();
  assert.equal(loaded[0].sportKey, 'football');
  assert.equal(loaded[0].active, true);
  assert.deepEqual(loaded[0].sizes, ['M']);

  await store.updateProduct({ ...product, name: 'Updated Jersey', price: 1700 });
  assert.equal(productRows[0].name, 'Updated Jersey');
  assert.equal(productRows[0].price, 1700);
  assert.deepEqual(productRows[0].sizes, ['M']);
  assert.ok(requests.every((request) => request.apiKey === testServiceRoleKey));
});

test('Supabase product images use the configured Storage bucket and can be removed', async () => {
  const uploaded = await store.uploadProductImage(Buffer.from('image bytes'), 'image/png');
  assert.match(uploaded.path, /^products\/[0-9a-f-]+\.png$/);
  assert.match(uploaded.url, /^http:\/\/127\.0\.0\.1:\d+\/storage\/v1\/object\/public\/product-images\//);

  const uploadRequest = requests.find((request) =>
    request.method === 'POST' &&
    request.url.pathname === `/storage/v1/object/product-images/${uploaded.path}`
  );
  assert.ok(uploadRequest);
  await store.deleteProductImage(uploaded.path);

  const deleteCall = requestBodies.find(
    (call) => call.resource === 'object/product-images'
  );
  assert.deepEqual(deleteCall.body, { prefixes: [uploaded.path] });
});
