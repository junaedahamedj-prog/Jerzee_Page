const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createApp } = require('../server');

const catalog = require('../data/products.json');
const adminUsername = randomBytes(8).toString('hex');
const adminPassword = randomBytes(32).toString('hex');

class TestSessionStore {
  constructor() {
    this.sessions = new Map();
  }

  async initialize() {}

  async set(id, data, expiresAt) {
    this.sessions.set(id, { ...data, expiresAt });
  }

  async get(id) {
    const session = this.sessions.get(id);
    return session?.expiresAt > Date.now() ? session : null;
  }

  async destroy(id) {
    this.sessions.delete(id);
  }
}

class TestProductStore {
  constructor() {
    this.products = catalog.map((product) => ({ ...product, active: true }));
    this.inventory = new Map();
    this.orders = [];
    this.images = new Map();
    this.deletedImages = [];
    this.uploadFails = false;
    this.createFails = false;
    this.uploadCount = 0;
    this.nextOrderId = 1;

    this.products.forEach((product) => {
      product.sizes.forEach((size) => {
        this.inventory.set(`${product.id}:${size}`, {
          product_id: product.id,
          size,
          available_quantity: 0,
          low_stock_threshold: 5,
        });
      });
    });
  }

  async initialize() {}

  async listProducts() {
    return this.products.map((product) => ({ ...product, sizes: [...product.sizes] }));
  }

  async listInventory() {
    return [...this.inventory.values()].map((stock) => ({ ...stock }));
  }

  async createProduct(product, initialStock) {
    if (this.createFails) throw new Error('Database unavailable');
    this.products.push({ ...product, sizes: [...product.sizes] });
    product.sizes.forEach((size) => {
      this.inventory.set(`${product.id}:${size}`, {
        product_id: product.id,
        size,
        available_quantity: initialStock[size],
        low_stock_threshold: 5,
      });
    });
  }

  async updateProduct(product) {
    const current = this.products.find((item) => item.id === product.id);
    if (!current) return false;
    Object.assign(current, product);
    return true;
  }

  async uploadProductImage(buffer, contentType) {
    this.uploadCount += 1;
    if (this.uploadFails) {
      const error = new Error('Storage unavailable');
      error.resource = 'storage/object/product-images';
      throw error;
    }
    const path = `products/${this.uploadCount}.png`;
    this.images.set(path, { buffer, contentType });
    return { path, url: `https://images.example/${path}` };
  }

  async deleteProductImage(path) {
    this.images.delete(path);
    this.deletedImages.push(path);
  }

  async createInventoryOrders(customer, requestedOrders) {
    const ids = [];
    for (const item of requestedOrders) {
      const stock = this.inventory.get(`${item.productId}:${item.size}`);
      if (!stock || stock.available_quantity < item.quantity) {
        const error = new Error('OUT_OF_STOCK');
        error.code = 'P0001';
        throw error;
      }
    }
    for (const item of requestedOrders) {
      this.inventory.get(`${item.productId}:${item.size}`).available_quantity -= item.quantity;
      const id = this.nextOrderId++;
      this.orders.push({
        id,
        ...customer,
        product: item.product,
        product_id: item.productId,
        size: item.size,
        quantity: item.quantity,
        total: item.total,
        status: 'Pending Confirmation',
        stock_reserved: true,
      });
      ids.push(id);
    }
    return ids;
  }

  async getOrderById(id) {
    return this.orders.find((order) => order.id === id) || null;
  }

  async updatePendingInventoryOrder(id, updates, productId) {
    const order = await this.getOrderById(id);
    if (!order || order.status !== 'Pending Confirmation') return { updated: false };
    const stock = this.inventory.get(`${productId}:${order.size}`);
    const delta = order.stock_reserved ? updates.quantity - order.quantity : updates.quantity;
    if (!stock || (delta > 0 && stock.available_quantity < delta)) {
      const error = new Error('OUT_OF_STOCK');
      error.code = 'P0001';
      throw error;
    }
    stock.available_quantity -= delta;
    order.quantity = updates.quantity;
    order.total = updates.total;
    order.status = updates.status || order.status;
    return { updated: true };
  }

  async cancelPendingInventoryOrder(id) {
    const order = await this.getOrderById(id);
    if (!order || order.status !== 'Pending Confirmation') return { updated: false };
    if (order.stock_reserved) {
      this.inventory.get(`${order.product_id}:${order.size}`).available_quantity += order.quantity;
    }
    order.status = 'Cancelled';
    order.stock_reserved = false;
    return { updated: true };
  }
}

let server;
let store;
let baseUrl;
let adminCookie;

async function request(path, { method = 'GET', body, authenticated = true } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(authenticated && adminCookie ? { Cookie: adminCookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    response,
    result: await response.json(),
  };
}

async function login() {
  const response = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  });
  assert.equal(response.status, 200);
  adminCookie = response.headers.get('set-cookie').split(';')[0];
}

function validProduct(overrides = {}) {
  return {
    name: 'Training Jersey',
    category: 'Football',
    price: 1499,
    description: 'A durable training jersey.',
    active: true,
    imageUrl: 'https://images.example/training.jpg',
    sizes: ['M', 'L'],
    initialStock: { M: 4, L: 0 },
    ...overrides,
  };
}

function pngFixture() {
  const image = Buffer.alloc(45);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image, 0);
  image.writeUInt32BE(13, 8);
  image.write('IHDR', 12, 'ascii');
  image.writeUInt32BE(1, 16);
  image.writeUInt32BE(1, 20);
  image[24] = 8;
  image[25] = 2;
  image.writeUInt32BE(0, 33);
  image.write('IEND', 37, 'ascii');
  image.writeUInt32BE(0, 41);
  return image;
}

test.beforeEach(async () => {
  store = new TestProductStore();
  adminCookie = '';
  const app = createApp(store, {
    adminUsername,
    adminPassword,
    sessionStore: new TestSessionStore(),
  });
  server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    listeningServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterEach(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server = null;
});

test('product management requires admin authentication and loads active products by category', async () => {
  const unauthorized = await request('/api/admin/products', { authenticated: false });
  assert.equal(unauthorized.response.status, 401);

  await login();
  const all = await request('/api/admin/products');
  assert.equal(all.response.status, 200);
  assert.equal(all.result.length, catalog.length);
  assert.ok(all.result.every((product) => product.active));

  const football = await request('/api/products?sport=football', { authenticated: false });
  assert.equal(football.response.status, 200);
  assert.ok(football.result.length > 0);
  assert.ok(football.result.every((product) => product.sportKey === 'football'));
});

test('product creation validates fields, stores image and initializes size inventory', async () => {
  await login();
  const invalid = await request('/api/admin/products', {
    method: 'POST',
    body: validProduct({
      category: 'Basketball',
      price: -10,
      sizes: ['XXXL'],
      initialStock: { XXXL: -1 },
    }),
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(store.products.length, catalog.length);

  const created = await request('/api/admin/products', {
    method: 'POST',
    body: validProduct({
      name: 'Uploaded Jersey',
      imageUrl: '',
      imageFile: {
        contentType: 'image/png',
        data: pngFixture().toString('base64'),
      },
    }),
  });
  assert.equal(created.response.status, 201);
  const createdProduct = created.result.product;
  assert.equal(createdProduct.name, 'Uploaded Jersey');
  assert.match(createdProduct.image, /^https:\/\/images\.example\//);
  assert.equal(store.inventory.get(`${createdProduct.id}:M`).available_quantity, 4);
  assert.equal(store.inventory.get(`${createdProduct.id}:L`).available_quantity, 0);
  assert.equal(store.images.size, 1);

  const visible = await request('/api/products', { authenticated: false });
  assert.ok(visible.result.some((product) => product.id === createdProduct.id));
});

test('invalid and failed image uploads do not create products or leave uploaded files', async () => {
  await login();
  const badImage = await request('/api/admin/products', {
    method: 'POST',
    body: validProduct({
      imageUrl: '',
      imageFile: { contentType: 'image/png', data: Buffer.from('not an image').toString('base64') },
    }),
  });
  assert.equal(badImage.response.status, 400);
  assert.equal(store.uploadCount, 0);

  store.uploadFails = true;
  const storageFailure = await request('/api/admin/products', {
    method: 'POST',
    body: validProduct({
      imageUrl: '',
      imageFile: { contentType: 'image/png', data: pngFixture().toString('base64') },
    }),
  });
  assert.equal(storageFailure.response.status, 502);
  assert.equal(store.products.length, catalog.length);

  store.uploadFails = false;
  store.createFails = true;
  const databaseFailure = await request('/api/admin/products', {
    method: 'POST',
    body: validProduct({
      imageUrl: '',
      imageFile: { contentType: 'image/png', data: pngFixture().toString('base64') },
    }),
  });
  assert.equal(databaseFailure.response.status, 500);
  assert.equal(store.products.length, catalog.length);
  assert.equal(store.images.size, 0);
  assert.equal(store.deletedImages.length, 1);
});

test('editing and deactivation preserve inventory and order history, while checkout rejects inactive products', async () => {
  await login();
  const created = await request('/api/admin/products', {
    method: 'POST',
    body: validProduct({ name: 'Original Name' }),
  });
  assert.equal(created.response.status, 201);
  const product = created.result.product;

  const updated = await request(`/api/admin/products/${product.id}`, {
    method: 'PATCH',
    body: {
      name: 'Updated Name',
      category: 'Cricket',
      price: 1599,
      description: 'Updated description.',
      active: true,
      imageUrl: product.image,
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(store.inventory.get(`${product.id}:M`).available_quantity, 4);

  const checkout = await request('/api/orders', {
    method: 'POST',
    authenticated: false,
    body: {
      customerName: 'Test customer',
      email: 'customer@example.com',
      phone: '0123456789',
      address: 'Dhaka',
      product_id: product.id,
      size: 'M',
      quantity: 1,
    },
  });
  assert.equal(checkout.response.status, 201);
  const order = store.orders[0];
  assert.equal(order.product, 'Updated Name');

  const renamed = await request(`/api/admin/products/${product.id}`, {
    method: 'PATCH',
    body: {
      name: 'Renamed Again',
      category: 'Cricket',
      price: 1699,
      description: 'Updated description again.',
      active: true,
      imageUrl: product.image,
    },
  });
  assert.equal(renamed.response.status, 200);
  const adjustedOrder = await request(`/api/orders/${order.id}/quantity`, {
    method: 'PATCH',
    body: { quantity: 2 },
  });
  assert.equal(adjustedOrder.response.status, 200);
  assert.equal(adjustedOrder.result.total, 3398);
  assert.equal(order.product, 'Updated Name');
  assert.equal(store.inventory.get(`${product.id}:M`).available_quantity, 2);

  const inactive = await request(`/api/admin/products/${product.id}`, {
    method: 'PATCH',
    body: {
      name: 'Renamed Again',
      category: 'Cricket',
      price: 1699,
      description: 'Updated description again.',
      active: false,
      imageUrl: product.image,
    },
  });
  assert.equal(inactive.response.status, 200);
  const storefront = await request('/api/products', { authenticated: false });
  assert.ok(!storefront.result.some((item) => item.id === product.id));
  const rejectedCheckout = await request('/api/orders', {
    method: 'POST',
    authenticated: false,
    body: {
      customerName: 'Test customer',
      email: 'customer@example.com',
      phone: '0123456789',
      address: 'Dhaka',
      product_id: product.id,
      size: 'M',
      quantity: 1,
    },
  });
  assert.equal(rejectedCheckout.response.status, 400);
  assert.equal(store.orders.length, 1);

  const cancelled = await request(`/api/orders/${order.id}/cancel`, { method: 'PATCH' });
  assert.equal(cancelled.response.status, 200);
  assert.equal(order.status, 'Cancelled');
  assert.equal(store.inventory.get(`${product.id}:M`).available_quantity, 4);

  const reactivated = await request(`/api/admin/products/${product.id}`, {
    method: 'PATCH',
    body: {
      name: 'Renamed Again',
      category: 'Cricket',
      price: 1699,
      description: 'Updated description again.',
      active: true,
      imageUrl: product.image,
    },
  });
  assert.equal(reactivated.response.status, 200);
  const visibleAgain = await request('/api/products', { authenticated: false });
  assert.ok(visibleAgain.result.some((item) => item.id === product.id));
});
