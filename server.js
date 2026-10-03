const express = require('express');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const dbDir = path.join(__dirname, 'data');
const dbPath = path.join(dbDir, 'jerzee.db');

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let SQL = null;
let db = null;
const dbReady = initSqlJs().then((sql) => {
  SQL = sql;
  initDatabase();
});

function saveDatabase() {
  if (!db) return;
  const binary = db.export();
  fs.writeFileSync(dbPath, Buffer.from(binary));
}

function parseOrders() {
  if (!db) return [];

  const results = db.exec('SELECT * FROM orders ORDER BY id DESC');
  if (!results.length) return [];

  return results[0].values.map((values) => {
    const row = {};
    results[0].columns.forEach((column, index) => {
      row[column] = values[index];
    });
    return row;
  });
}

function deleteOrderById(id) {
  if (!db) return;
  db.run('DELETE FROM orders WHERE id = ?', [Number(id)]);
  saveDatabase();
}

function clearCancelledOrders() {
  if (!db) return;
  db.run("DELETE FROM orders WHERE LOWER(COALESCE(status, '')) = 'cancelled'");
  saveDatabase();
}

function initDatabase() {
  if (!SQL) return;

  const fileBuffer = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  db = new SQL.Database(fileBuffer || undefined);
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    email TEXT,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    product TEXT NOT NULL,
    size TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const orderColumns = db.exec('PRAGMA table_info(orders)')[0]?.values || [];
  if (!orderColumns.some((column) => column[1] === 'email')) {
    db.run('ALTER TABLE orders ADD COLUMN email TEXT');
  }
  clearCancelledOrders();
  saveDatabase();
}

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

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  await dbReady;

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  const orders = parseOrders();
  const cancelledIds = orders
    .filter((order) => String(order.status ?? '').trim().toLowerCase() === 'cancelled')
    .map((order) => order.id);

  cancelledIds.forEach((id) => deleteOrderById(id));
  if (cancelledIds.length) {
    clearCancelledOrders();
  }

  const visibleOrders = parseOrders().filter(
    (order) => String(order.status ?? '').trim().toLowerCase() !== 'cancelled'
  );

  res.json(visibleOrders);
});

app.post('/api/orders', async (req, res) => {
  await dbReady;

  const email = String(req.body?.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  const orderData = sanitizeOrderInput(req.body);
  if (!orderData) {
    return res.status(400).json({ error: 'Please provide valid order details for all required fields.' });
  }

  const { customerName, phone, address, product, size, quantity, total } = orderData;
  db.run(
    `INSERT INTO orders (customer_name, email, phone, address, product, size, quantity, total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [customerName, email, phone, address, product, size, quantity, total]
  );
  saveDatabase();

  const result = db.exec('SELECT id FROM orders ORDER BY id DESC LIMIT 1');
  const orderId = Number(result[0]?.values?.[0]?.[0] ?? 0);

  return res.status(201).json({ message: 'Order placed successfully!', orderId });
});

app.patch('/api/orders/:id', async (req, res) => {
  await dbReady;

  const normalizedStatus = normalizeStatus(req.body?.status);

  if (!normalizedStatus) {
    return res.status(400).json({ error: 'Invalid status.' });
  }

  if (normalizedStatus === 'Cancelled') {
    deleteOrderById(req.params.id);
    clearCancelledOrders();
    return res.json({ message: 'Order cancelled and removed.' });
  }

  db.run('UPDATE orders SET status = ? WHERE id = ?', [normalizedStatus, Number(req.params.id)]);
  saveDatabase();

  return res.json({ message: `Status updated to ${normalizedStatus}.` });
});

app.delete('/api/orders/:id', async (req, res) => {
  await dbReady;
  deleteOrderById(req.params.id);
  return res.json({ message: 'Order deleted.' });
});

async function startServer(port = PORT, host = HOST) {
  await dbReady;
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
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
  startServer();
}

module.exports = { app, startServer };
