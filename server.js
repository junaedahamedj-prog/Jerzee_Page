require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createHash, createHmac, randomBytes, timingSafeEqual } = require('crypto');
const { SupabaseOrdersStore } = require('./supabase-orders-store');
const { SupabaseSessionStore } = require('./supabase-session-store');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_DATABASE_INTEGER = 2147483647;
const ADMIN_SESSION_COOKIE = 'jerzee_admin_session';
const ADMIN_SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_MAX_ATTEMPTS = 5;

function validateEnvironment(env = process.env) {
  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ADMIN_USERNAME',
    'ADMIN_PASSWORD',
  ];
  const missing = required.filter((name) => !String(env[name] || '').trim());
  if (missing.length) {
    const error = new Error(`Missing required environment variables: ${missing.join(', ')}`);
    error.code = 'INVALID_ENVIRONMENT_CONFIGURATION';
    throw error;
  }

  let supabaseUrl;
  try {
    supabaseUrl = new URL(env.SUPABASE_URL);
  } catch {
    const error = new Error('SUPABASE_URL must be a valid URL.');
    error.code = 'INVALID_ENVIRONMENT_CONFIGURATION';
    throw error;
  }
  if (!['http:', 'https:'].includes(supabaseUrl.protocol) ||
      (env.NODE_ENV === 'production' && supabaseUrl.protocol !== 'https:')) {
    const error = new Error('SUPABASE_URL must use HTTPS in production.');
    error.code = 'INVALID_ENVIRONMENT_CONFIGURATION';
    throw error;
  }
}

function constantTimeStringEqual(supplied, expected) {
  return timingSafeEqual(
    createHash('sha256').update(String(supplied)).digest(),
    createHash('sha256').update(String(expected)).digest()
  );
}

function readSessionCookie(req) {
  const cookieHeader = req.get('Cookie') || '';
  const cookie = cookieHeader.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  return cookie ? cookie.slice(ADMIN_SESSION_COOKIE.length + 1) : '';
}

function prepareOrderInput(payload = {}, customer = payload, products = getProductsCatalog()) {
  const customerName = String(customer.customerName || '').trim();
  const email = String(customer.email || '').trim();
  const phone = String(customer.phone || '').trim();
  const address = String(customer.address || '').trim();
  const productId = String(payload.product_id || '').trim();
  const product = products.find((item) => item.id === productId);
  const size = String(payload.size || '').trim();
  const quantity = Number(payload.quantity);

  if (!customerName || !phone || !address) {
    return { error: 'Please provide valid customer details.' };
  }
  if (!product) {
    return { error: 'Invalid product' };
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_DATABASE_INTEGER) {
    return { error: 'Invalid quantity' };
  }
  if (!size || (Array.isArray(product.sizes) && !product.sizes.includes(size))) {
    return { error: 'Invalid size for product' };
  }

  const total = Number(product.price) * quantity;
  if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_DATABASE_INTEGER) {
    return { error: 'Product price is unavailable.' };
  }

  return {
    order: {
      productId: product.id,
      customerName,
      email,
      phone,
      address,
      product: product.name,
      size,
      quantity,
      total,
      status: PENDING_CONFIRMATION,
    },
  };
}

function normalizeStatus(status) {
  const value = String(status ?? '').trim();
  if (!value) return null;

  const normalized = value.toLowerCase();
  const map = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    shipped: 'Shipped',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
  };

  return map[normalized] || null;
}

const PENDING_CONFIRMATION = 'Pending Confirmation';

function parseOrderId(value) {
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

async function getOrderById(orderStore, id) {
  if (typeof orderStore.getOrderById === 'function') {
    return orderStore.getOrderById(id);
  }
  const orders = await orderStore.listOrders();
  return orders.find((item) => Number(item.id) === id) || null;
}

const productsFilePath = path.join(__dirname, 'data', 'products.json');

function getProductsCatalog() {
  try {
    if (fs.existsSync(productsFilePath)) {
      const data = fs.readFileSync(productsFilePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading products catalog:', err);
  }
  return [];
}

function createApp(orderStore = new SupabaseOrdersStore(), options = {}) {
  const app = express();
  const adminUsername = options.adminUsername ?? process.env.ADMIN_USERNAME;
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD;
  const adminConfigured = Boolean(adminUsername && adminPassword);
  const sessionStore = options.sessionStore ?? new SupabaseSessionStore();
  const sessionDurationMs = options.sessionDurationMs ?? ADMIN_SESSION_DURATION_MS;
  const rateLimitOptions = options.loginRateLimit ?? {};
  const rateLimitWindowMs = rateLimitOptions.windowMs ?? LOGIN_RATE_WINDOW_MS;
  const rateLimitMaxAttempts = rateLimitOptions.maxAttempts ?? LOGIN_RATE_MAX_ATTEMPTS;
  const loginAttempts = new Map();
  const needsSupabaseConfiguration = orderStore instanceof SupabaseOrdersStore;

  function getLoginRateLimitKey(req) {
    const address = req.ip || req.socket.remoteAddress || 'unknown';
    return createHmac('sha256', adminPassword).update(address).digest('hex');
  }

  if (process.env.VERCEL) {
    app.set('trust proxy', 1);
  }

  async function initializeSessionStore() {
    if (!app.locals.sessionStoreReady) {
      app.locals.sessionStoreReady = Promise.resolve().then(() => sessionStore.initialize());
    }
    return app.locals.sessionStoreReady;
  }

  function setSessionCookie(res, sessionId, maxAgeMs) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.set('Set-Cookie',
      `${ADMIN_SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Strict${secure}`);
  }

  function clearSessionCookie(res) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.set('Set-Cookie',
      `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`);
  }

  async function requireAdmin(req, res, next) {
    if (!adminConfigured) {
      return res.status(503).json({ error: 'Admin access is not configured on this server.' });
    }

    try {
      await initializeSessionStore();
      const sessionId = readSessionCookie(req);
      const session = sessionId ? await sessionStore.get(sessionId) : null;
      if (!session?.authenticated) {
        clearSessionCookie(res);
        if (req.path === '/staff' || req.path === '/admin.html') {
          return res.redirect(302, '/admin/login');
        }
        return res.status(401).json({ error: 'Authentication required.' });
      }
      req.adminSessionId = sessionId;
      next();
    } catch (error) {
      next(error);
    }
  }

  async function checkLoginRateLimit(req, res) {
    const now = Date.now();
    const key = getLoginRateLimitKey(req);
    if (typeof sessionStore.consumeLoginAttempt === 'function') {
      const result = await sessionStore.consumeLoginAttempt(
        key,
        now,
        rateLimitWindowMs,
        rateLimitMaxAttempts
      );
      if (!result.allowed) {
        res.set('Retry-After', String(Math.max(1, result.retry_after_seconds)));
        res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
        return false;
      }
      return true;
    }

    const recentAttempts = (loginAttempts.get(key) || [])
      .filter((timestamp) => now - timestamp < rateLimitWindowMs);

    if (recentAttempts.length >= rateLimitMaxAttempts) {
      const retryAfterSeconds = Math.max(1, Math.ceil(
        (recentAttempts[0] + rateLimitWindowMs - now) / 1000
      ));
      res.set('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
      return false;
    }

    recentAttempts.push(now);
    if (loginAttempts.size > 10000) {
      for (const [attemptKey, timestamps] of loginAttempts) {
        if (!timestamps.some((timestamp) => now - timestamp < rateLimitWindowMs)) {
          loginAttempts.delete(attemptKey);
        }
      }
    }
    loginAttempts.set(key, recentAttempts);
    return true;
  }

  app.locals.orderStore = orderStore;
  app.locals.sessionStore = sessionStore;
  app.locals.requiresEnvironmentValidation = needsSupabaseConfiguration;
  app.locals.initializeSessionStore = initializeSessionStore;
  app.locals.validateEnvironment = validateEnvironment;
  let orderStoreReady;
  app.locals.initializeOrderStore = () => {
    if (!orderStoreReady) {
      orderStoreReady = Promise.resolve().then(() => orderStore.initialize());
    }
    return orderStoreReady;
  };

  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    if (!needsSupabaseConfiguration) return next();
    try {
      validateEnvironment();
      next();
    } catch (error) {
      res.status(503).json({ error: error.message });
    }
  });

  app.get('/admin/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
  });
  app.post('/admin/login', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!adminConfigured) {
      return res.status(503).json({ error: 'Admin access is not configured on this server.' });
    }
    try {
      if (!await checkLoginRateLimit(req, res)) return;
    } catch (error) {
      return next(error);
    }

    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!constantTimeStringEqual(username, adminUsername) ||
        !constantTimeStringEqual(password, adminPassword)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    try {
      await initializeSessionStore();
      const previousSessionId = readSessionCookie(req);
      if (previousSessionId) await sessionStore.destroy(previousSessionId);

      const sessionId = randomBytes(32).toString('base64url');
      await sessionStore.set(sessionId, { authenticated: true }, Date.now() + sessionDurationMs);
      const rateLimitKey = getLoginRateLimitKey(req);
      if (typeof sessionStore.resetLoginAttempts === 'function') {
        await sessionStore.resetLoginAttempts(rateLimitKey);
      }
      loginAttempts.delete(rateLimitKey);
      setSessionCookie(res, sessionId, sessionDurationMs);
      return res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  app.post('/admin/logout', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const sessionId = readSessionCookie(req);
      if (sessionId) {
        await initializeSessionStore();
        await sessionStore.destroy(sessionId);
      }
      clearSessionCookie(res);
      return res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  app.get(['/staff', '/admin.html'], requireAdmin, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });
  app.use('/api/orders', (req, res, next) => {
    if (req.method === 'POST') return next();
    return requireAdmin(req, res, next);
  });
  app.use('/api/inventory', requireAdmin);
  app.use(['/api/orders', '/api/products', '/api/inventory'], async (req, res, next) => {
    try {
      await req.app.locals.initializeOrderStore();
      next();
    } catch (error) {
      next(error);
    }
  });
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/products', async (req, res) => {
    const { sport, q } = req.query;
    let products = getProductsCatalog();
    const inventory = await req.app.locals.orderStore.listInventory();
    const availabilityBySize = new Map(
      inventory.map((row) => [`${row.product_id}:${row.size}`, Number(row.available_quantity)])
    );

    if (sport && sport !== 'all') {
      const targetSport = String(sport).trim().toLowerCase();
      products = products.filter(
        (p) => String(p.sportKey || '').toLowerCase() === targetSport ||
               String(p.sport || '').toLowerCase() === targetSport
      );
    }

    if (q) {
      const query = String(q).trim().toLowerCase();
      products = products.filter(
        (p) => p.name.toLowerCase().includes(query) ||
               (p.sport && p.sport.toLowerCase().includes(query)) ||
               (p.description && p.description.toLowerCase().includes(query))
      );
    }

    res.set('Cache-Control', 'no-store');
    res.json(products.map((product) => ({
      ...product,
      availability: (product.sizes || []).map((size) => ({
        size,
        availableQuantity: availabilityBySize.get(`${product.id}:${size}`) || 0,
        inStock: (availabilityBySize.get(`${product.id}:${size}`) || 0) > 0,
      })),
    })));
  });

  app.get('/api/inventory', async (req, res) => {
    const products = getProductsCatalog();
    const productById = new Map(products.map((product) => [product.id, product]));
    const inventory = await req.app.locals.orderStore.listInventory();
    res.set('Cache-Control', 'no-store');
    res.json(inventory.map((stock) => ({
      ...stock,
      product_name: productById.get(stock.product_id)?.name || 'Unknown product',
    })));
  });

  app.patch('/api/inventory/:productId/:size', async (req, res) => {
    const { productId, size } = req.params;
    const product = getProductsCatalog().find((item) => item.id === productId);
    const quantity = req.body?.quantity;
    if (!product || !Array.isArray(product.sizes) || !product.sizes.includes(size)) {
      return res.status(404).json({ error: 'Unknown product or size.' });
    }
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_DATABASE_INTEGER) {
      return res.status(400).json({ error: 'Stock quantity must be a non-negative integer.' });
    }

    const updated = await req.app.locals.orderStore.setInventoryStock(productId, size, quantity);
    if (!updated) {
      return res.status(404).json({ error: 'Inventory has not been initialized for this product and size.' });
    }
    return res.json({ message: 'Stock updated.', stock: updated });
  });

  app.get('/api/orders', async (req, res) => {
    const { orderStore } = req.app.locals;

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    res.json(await orderStore.listOrders());
  });

  app.post('/api/orders', async (req, res) => {
    const email = String(req.body?.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    if (Array.isArray(req.body?.items)) {
      const { customerName, phone, address } = req.body;
      const items = req.body.items;

      if (!String(customerName || '').trim() || !String(phone || '').trim() ||
          !String(address || '').trim() || items.length < 1 || items.length > 50) {
        return res.status(400).json({ error: 'Please provide valid customer details and between 1 and 50 order items.' });
      }

      const products = getProductsCatalog();
      const preparedItems = items.map((item) => prepareOrderInput(
        item,
        { customerName, email, phone, address },
        products
      ));

      if (preparedItems.some((item) => !item.order)) {
        return res.status(400).json({ error: 'Please provide valid details for every item in the cart.' });
      }

      const orderItems = preparedItems.map((item) => item.order);
      const orderIds = await req.app.locals.orderStore.createInventoryOrders(
        { customerName, email, phone, address },
        orderItems
      );
      return res.status(201).json({
        message: 'All items ordered successfully!',
        orderIds,
      });
    }

    const preparedOrder = prepareOrderInput(req.body, { ...req.body, email });
    if (!preparedOrder.order) {
      return res.status(400).json({ error: preparedOrder.error });
    }

    const [orderId] = await req.app.locals.orderStore.createInventoryOrders(
      {
        customerName: preparedOrder.order.customerName,
        email,
        phone: preparedOrder.order.phone,
        address: preparedOrder.order.address,
      },
      [preparedOrder.order]
    );

    return res.status(201).json({ message: 'Order placed successfully!', orderId });
  });

  app.patch('/api/orders/:id/quantity', async (req, res) => {
    const id = parseOrderId(req.params.id);
    const quantity = req.body?.quantity;
    if (!id || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_DATABASE_INTEGER) {
      return res.status(400).json({ error: 'Please provide a valid order ID and positive integer quantity.' });
    }

    const order = await getOrderById(req.app.locals.orderStore, id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (order.status !== PENDING_CONFIRMATION) {
      return res.status(409).json({ error: 'Only pending confirmation orders can be edited.' });
    }

    const product = getProductsCatalog().find((item) => item.name === order.product);
    if (!product || !Array.isArray(product.sizes) || !product.sizes.includes(order.size)) {
      return res.status(400).json({ error: 'The order product or size is no longer valid.' });
    }
    const total = Number(product.price) * quantity;
    if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_DATABASE_INTEGER) {
      return res.status(400).json({ error: 'Product price is unavailable.' });
    }

    const result = await req.app.locals.orderStore.updatePendingInventoryOrder(
      id,
      { quantity, total },
      product.id
    );
    if (!result.updated) {
      return res.status(409).json({ error: 'Only pending confirmation orders can be edited.' });
    }

    return res.json({ message: 'Order quantity updated.', quantity, total });
  });

  app.patch('/api/orders/:id/confirm', async (req, res) => {
    const id = parseOrderId(req.params.id);
    if (!id || (req.body?.quantity !== undefined &&
        (!Number.isInteger(req.body.quantity) || req.body.quantity < 1 ||
          req.body.quantity > MAX_DATABASE_INTEGER))) {
      return res.status(400).json({ error: 'Please provide a valid order ID and positive integer quantity.' });
    }

    const order = await getOrderById(req.app.locals.orderStore, id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (order.status !== PENDING_CONFIRMATION) {
      return res.status(409).json({ error: 'Only pending confirmation orders can be confirmed.' });
    }

    const product = getProductsCatalog().find((item) => item.name === order.product);
    if (!product || !Array.isArray(product.sizes) || !product.sizes.includes(order.size)) {
      return res.status(400).json({ error: 'The order product or size is no longer valid.' });
    }
    const quantity = req.body?.quantity ?? order.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_DATABASE_INTEGER) {
      return res.status(400).json({ error: 'Please provide a positive integer quantity.' });
    }
    const total = Number(product.price) * quantity;
    if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_DATABASE_INTEGER) {
      return res.status(400).json({ error: 'Product price is unavailable.' });
    }

    const result = await req.app.locals.orderStore.updatePendingInventoryOrder(
      id,
      { quantity, total, status: 'Confirmed' },
      product.id
    );
    if (!result.updated) {
      return res.status(409).json({ error: 'Only pending confirmation orders can be confirmed.' });
    }

    return res.json({ message: 'Order confirmed.', quantity, total, status: 'Confirmed' });
  });

  app.patch('/api/orders/:id/cancel', async (req, res) => {
    const id = parseOrderId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Please provide a valid order ID.' });
    }

    const order = await getOrderById(req.app.locals.orderStore, id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (order.status !== PENDING_CONFIRMATION) {
      return res.status(409).json({ error: 'Only pending confirmation orders can be cancelled.' });
    }

    const result = await req.app.locals.orderStore.cancelPendingInventoryOrder(id);
    if (!result.updated) {
      return res.status(409).json({ error: 'Only pending confirmation orders can be cancelled.' });
    }

    return res.json({ message: 'Order cancelled.', status: 'Cancelled' });
  });

  app.patch('/api/orders/:id', async (req, res) => {
    const id = parseOrderId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Please provide a valid order ID.' });
    }
    const normalizedStatus = normalizeStatus(req.body?.status);

    if (!normalizedStatus || normalizedStatus === 'Cancelled' || normalizedStatus === PENDING_CONFIRMATION) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    const order = await getOrderById(req.app.locals.orderStore, id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (order.status === PENDING_CONFIRMATION) {
      return res.status(409).json({ error: 'Confirm or cancel pending orders using their dedicated actions.' });
    }
    const permittedNextStatuses = {
      Confirmed: ['Confirmed', 'Shipped'],
      Shipped: ['Shipped', 'Delivered'],
      Delivered: ['Delivered'],
    };
    if (!permittedNextStatuses[order.status]?.includes(normalizedStatus)) {
      return res.status(409).json({ error: 'Invalid order status transition.' });
    }

    await req.app.locals.orderStore.updateOrderStatus(id, normalizedStatus);

    return res.json({ message: `Status updated to ${normalizedStatus}.` });
  });

  app.delete('/api/orders/:id', async (req, res) => {
    const id = parseOrderId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Please provide a valid order ID.' });
    }
    const order = await getOrderById(req.app.locals.orderStore, id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (order.status === PENDING_CONFIRMATION) {
      return res.status(409).json({
        error: 'Cancel this pending order to release its reserved stock; order history is preserved.',
      });
    }
    await req.app.locals.orderStore.deleteOrderById(id);
    return res.json({ message: 'Order deleted.' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    console.error('Request failed:', error.code || error.name || 'Error');
    if (error.code === 'P0001' && error.message === 'OUT_OF_STOCK') {
      return res.status(409).json({ error: 'The requested size no longer has enough stock.' });
    }
    if (error.code === 'P0001' && error.message === 'INVENTORY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Inventory is not initialized. Run supabase/schema.sql in the Supabase SQL Editor.' });
    }
    if (error.code === 'SUPABASE_NOT_CONFIGURED') {
      return res.status(503).json({ error: error.message });
    }
    if ((error.code === 'PGRST205' || error.code === '42P01') &&
        error.resource === 'admin_sessions') {
      return res.status(503).json({
        error: 'Admin session storage is missing. Run supabase/schema.sql in the Supabase SQL Editor.',
      });
    }
    if (((error.code === 'PGRST205' || error.code === '42P01') &&
        error.resource === 'admin_login_attempts') ||
        (error.code === '42P01' && error.resource === 'rpc/consume_admin_login_attempt')) {
      return res.status(503).json({
        error: 'Admin login rate-limit storage is missing. Run supabase/schema.sql in the Supabase SQL Editor.',
      });
    }
    if (error.code === 'PGRST202' && error.resource === 'rpc/consume_admin_login_attempt') {
      return res.status(503).json({
        error: 'Admin login rate limiting is not configured. Run supabase/schema.sql in the Supabase SQL Editor.',
      });
    }
    if ((error.code === 'PGRST205' || error.code === '42P01') &&
        error.resource === 'orders') {
      return res.status(503).json({
        error: 'The Supabase orders table is missing. Run supabase/schema.sql in the Supabase SQL Editor.',
      });
    }
    if ((error.code === 'PGRST205' || error.code === '42P01') &&
        (error.resource === 'inventory_stock' ||
          ['rpc/create_inventory_orders', 'rpc/update_pending_inventory_order',
            'rpc/cancel_pending_inventory_order', 'rpc/set_inventory_stock'].includes(error.resource))) {
      return res.status(503).json({
        error: 'The Supabase inventory table is missing. Run supabase/schema.sql in the Supabase SQL Editor.',
      });
    }
    if (error.code === 'PGRST202' &&
        ['rpc/create_inventory_orders', 'rpc/update_pending_inventory_order',
          'rpc/cancel_pending_inventory_order', 'rpc/set_inventory_stock'].includes(error.resource)) {
      return res.status(503).json({
        error: 'Inventory database functions are missing. Run supabase/schema.sql in the Supabase SQL Editor.',
      });
    }
    if (error.status === 401 || error.status === 403) {
      return res.status(503).json({
        error: 'Supabase credentials or orders-table permissions are not configured correctly.',
      });
    }
    return res.status(500).json({ error: 'The request could not be completed.' });
  });

  return app;
}

const app = createApp();

async function startServer(port = PORT, host = HOST, serverApp = app) {
  if (serverApp.locals.requiresEnvironmentValidation) {
    validateEnvironment();
  }
  await serverApp.locals.initializeOrderStore();
  await serverApp.locals.initializeSessionStore();
  return new Promise((resolve, reject) => {
    const server = serverApp.listen(port, host, () => {
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;

      console.log(`JERZEE listening on ${host}:${actualPort}`);
      console.log(`Open on this PC: http://localhost:${actualPort}`);
      console.log(`Access from another device on the same network: http://<YOUR-LAPTOP-IP>:${actualPort}`);
      console.log(`Admin dashboard: http://localhost:${actualPort}/staff (protected)`);
      resolve(server);
    });

    server.once('error', reject);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    const safeMessage = error.code === 'INVALID_ENVIRONMENT_CONFIGURATION' ||
      error.code === 'SUPABASE_NOT_CONFIGURED'
      ? error.message
      : 'Supabase initialization failed. Check connectivity and verify supabase/schema.sql is installed.';
    console.error('Failed to start JERZEE:', safeMessage);
    process.exitCode = 1;
  });
}

module.exports = Object.assign(app, { app, createApp, startServer, validateEnvironment });
