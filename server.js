require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createHash, timingSafeEqual } = require('crypto');
const { SupabaseOrdersStore } = require('./supabase-orders-store');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

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
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { error: 'Invalid quantity' };
  }
  if (!size || (Array.isArray(product.sizes) && !product.sizes.includes(size))) {
    return { error: 'Invalid size for product' };
  }

  const total = Number(product.price) * quantity;
  if (!Number.isFinite(total) || total <= 0) {
    return { error: 'Product price is unavailable.' };
  }

  return {
    order: {
      customerName,
      email,
      phone,
      address,
      product: product.name,
      size,
      quantity,
      total,
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

  function requireAdmin(req, res, next) {
    if (!adminConfigured) {
      return res.status(503).json({ error: 'Admin access is not configured on this server.' });
    }

    const authorization = req.get('Authorization') || '';
    const match = authorization.match(/^Basic\s+([A-Za-z0-9+/]+=*)$/i);
    if (!match) {
      res.set('WWW-Authenticate', 'Basic realm="JERZEE Admin", charset="UTF-8"');
      return res.status(401).send('Authentication required.');
    }

    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const suppliedUsername = separator < 0 ? '' : decoded.slice(0, separator);
    const suppliedPassword = separator < 0 ? '' : decoded.slice(separator + 1);
    const usernameMatches = timingSafeEqual(
      createHash('sha256').update(suppliedUsername).digest(),
      createHash('sha256').update(adminUsername).digest()
    );
    const passwordMatches = timingSafeEqual(
      createHash('sha256').update(suppliedPassword).digest(),
      createHash('sha256').update(adminPassword).digest()
    );

    if (separator < 0 || !usernameMatches || !passwordMatches) {
      res.set('WWW-Authenticate', 'Basic realm="JERZEE Admin", charset="UTF-8"');
      return res.status(401).send('Authentication required.');
    }

    next();
  }

  app.locals.orderStore = orderStore;
  let orderStoreReady;
  app.locals.initializeOrderStore = () => {
    if (!orderStoreReady) {
      orderStoreReady = Promise.resolve().then(() => orderStore.initialize());
    }
    return orderStoreReady;
  };

  app.use(express.json({ limit: '1mb' }));
  app.get(['/staff', '/admin.html'], requireAdmin, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });
  app.use('/api/orders', (req, res, next) => {
    if (['GET', 'PATCH', 'DELETE'].includes(req.method)) {
      return requireAdmin(req, res, next);
    }
    next();
  });
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/api/orders', async (req, res, next) => {
    try {
      await req.app.locals.initializeOrderStore();
      next();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/products', (req, res) => {
    const { sport, q } = req.query;
    let products = getProductsCatalog();

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

    res.json(products);
  });

  app.get('/api/orders', async (req, res) => {
    const { orderStore } = req.app.locals;

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    const orders = await orderStore.listOrders();
    const cancelledIds = orders
      .filter((order) => String(order.status ?? '').trim().toLowerCase() === 'cancelled')
      .map((order) => order.id);

    await Promise.all(cancelledIds.map((id) => orderStore.deleteOrderById(id)));
    if (cancelledIds.length) {
      await orderStore.clearCancelledOrders();
    }

    const visibleOrders = (cancelledIds.length ? await orderStore.listOrders() : orders).filter(
      (order) => String(order.status ?? '').trim().toLowerCase() !== 'cancelled'
    );

    res.json(visibleOrders);
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
      const orderIds = await req.app.locals.orderStore.createOrders(orderItems);
      return res.status(201).json({
        message: 'All items ordered successfully!',
        orderIds,
      });
    }

    const preparedOrder = prepareOrderInput(req.body, { ...req.body, email });
    if (!preparedOrder.order) {
      return res.status(400).json({ error: preparedOrder.error });
    }

    const orderId = await req.app.locals.orderStore.createOrder({
      ...preparedOrder.order,
    });

    return res.status(201).json({ message: 'Order placed successfully!', orderId });
  });

  app.patch('/api/orders/:id', async (req, res) => {
    const normalizedStatus = normalizeStatus(req.body?.status);

    if (!normalizedStatus) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    if (normalizedStatus === 'Cancelled') {
      await req.app.locals.orderStore.deleteOrderById(req.params.id);
      await req.app.locals.orderStore.clearCancelledOrders();
      return res.json({ message: 'Order cancelled and removed.' });
    }

    await req.app.locals.orderStore.updateOrderStatus(req.params.id, normalizedStatus);

    return res.json({ message: `Status updated to ${normalizedStatus}.` });
  });

  app.delete('/api/orders/:id', async (req, res) => {
    await req.app.locals.orderStore.deleteOrderById(req.params.id);
    return res.json({ message: 'Order deleted.' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    console.error('Request failed:', error);
    if (error.code === 'SUPABASE_NOT_CONFIGURED') {
      return res.status(503).json({ error: error.message });
    }
    if (error.code === 'PGRST205' || error.code === '42P01') {
      return res.status(503).json({
        error: 'The Supabase orders table is missing. Run supabase/schema.sql in the Supabase SQL Editor.',
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
  await serverApp.locals.initializeOrderStore();
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
    console.error('Failed to start JERZEE:', error.message);
    process.exitCode = 1;
  });
}

module.exports = Object.assign(app, { app, createApp, startServer });
