require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { SupabaseOrdersStore } = require('./supabase-orders-store');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

function sanitizeOrderInput(payload = {}) {
  const customerName = String(payload.customerName || '').trim();
  const email = String(payload.email || '').trim();
  const phone = String(payload.phone || '').trim();
  const address = String(payload.address || '').trim();
  const product = String(payload.product || '').trim();
  const size = String(payload.size || '').trim();
  const quantity = Number(payload.quantity);
  const total = Number(payload.total);

  if (
    !customerName ||
    !phone ||
    !address ||
    !product ||
    !size ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }

  return { customerName, email, phone, address, product, size, quantity, total };
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

function createApp(orderStore = new SupabaseOrdersStore()) {
  const app = express();
  app.locals.orderStore = orderStore;
  let orderStoreReady;
  app.locals.initializeOrderStore = () => {
    if (!orderStoreReady) {
      orderStoreReady = Promise.resolve().then(() => orderStore.initialize());
    }
    return orderStoreReady;
  };

  app.use(express.json({ limit: '1mb' }));
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

    const orderData = sanitizeOrderInput(req.body);
    if (!orderData) {
      return res.status(400).json({ error: 'Please provide valid order details for all required fields.' });
    }

    const orderId = await req.app.locals.orderStore.createOrder({
      ...orderData,
      email,
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
      console.log(`Admin dashboard: http://localhost:${actualPort}/admin.html`);
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
