require('dotenv').config();

const express = require('express');
const path = require('path');
const { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } = require('crypto');
const { SupabaseOrdersStore } = require('./supabase-orders-store');
const { SupabaseSessionStore } = require('./supabase-session-store');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_DATABASE_INTEGER = 2147483647;
const ADMIN_SESSION_COOKIE = 'jerzee_admin_session';
const ADMIN_SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_MAX_ATTEMPTS = 5;
const MAX_PRODUCT_IMAGE_BYTES = 650 * 1024;
const PRODUCT_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const PRODUCT_CATEGORIES = new Map([
  ['football', { sport: 'Football', sportKey: 'football' }],
  ['cricket', { sport: 'Cricket', sportKey: 'cricket' }],
  ['f1/racing', { sport: 'F1 / Racing', sportKey: 'racing' }],
  ['racing', { sport: 'F1 / Racing', sportKey: 'racing' }],
]);

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

function prepareOrderInput(payload = {}, customer = payload, products = []) {
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
  if (product.active === false) {
    return { error: 'This product is not available for purchase.' };
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

function getStaticProductsCatalog() {
  try {
    return require('./data/products.json');
  } catch (err) {
    console.error('Error reading products catalog:', err);
  }
  return [];
}

async function getProductsCatalog(orderStore) {
  if (typeof orderStore?.listProducts === 'function') {
    return orderStore.listProducts();
  }
  return getStaticProductsCatalog();
}

function validateProductImageFile(imageFile) {
  if (!imageFile || typeof imageFile !== 'object' ||
      typeof imageFile.data !== 'string' || typeof imageFile.contentType !== 'string') {
    return { error: 'Choose a valid PNG, JPEG, or WebP product image.' };
  }
  const supportedTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
  if (!supportedTypes.has(imageFile.contentType)) {
    return { error: 'Product images must be PNG, JPEG, or WebP.' };
  }
  if (imageFile.data.length > Math.ceil(MAX_PRODUCT_IMAGE_BYTES * 4 / 3) + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(imageFile.data)) {
    return { error: 'Product image is invalid or exceeds the 650 KB limit.' };
  }

  const buffer = Buffer.from(imageFile.data, 'base64');
  if (!buffer.length || buffer.length > MAX_PRODUCT_IMAGE_BYTES ||
      buffer.toString('base64') !== imageFile.data) {
    return { error: 'Product image is invalid or exceeds the 650 KB limit.' };
  }

  let isPng = imageFile.contentType === 'image/png' && buffer.length >= 45 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (isPng) {
    let offset = 8;
    let firstChunk = true;
    let foundEnd = false;
    while (offset + 12 <= buffer.length) {
      const chunkLength = buffer.readUInt32BE(offset);
      if (offset + chunkLength + 12 > buffer.length) {
        isPng = false;
        break;
      }
      const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
      if (firstChunk) {
        isPng = chunkType === 'IHDR' && chunkLength === 13 &&
          buffer.readUInt32BE(offset + 8) > 0 && buffer.readUInt32BE(offset + 12) > 0;
        firstChunk = false;
      }
      offset += chunkLength + 12;
      if (chunkType === 'IEND') {
        foundEnd = chunkLength === 0 && offset === buffer.length;
        break;
      }
    }
    isPng = isPng && foundEnd;
  }
  const isJpeg = imageFile.contentType === 'image/jpeg' &&
    buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 &&
    buffer[2] === 0xff && buffer[buffer.length - 2] === 0xff &&
    buffer[buffer.length - 1] === 0xd9;
  const isWebp = imageFile.contentType === 'image/webp' &&
    buffer.length >= 20 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP' &&
    buffer.readUInt32LE(4) + 8 === buffer.length;
  if (!isPng && !isJpeg && !isWebp) {
    return { error: 'The image contents do not match the selected image type.' };
  }
  return { buffer };
}

function validateProductInput(body, { existing, creating }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Provide valid product details.' };
  }

  const fields = {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const categoryValue = typeof body.category === 'string'
    ? body.category.trim().toLowerCase().replace(/\s+/g, '')
    : '';
  const category = PRODUCT_CATEGORIES.get(categoryValue);
  const price = body.price;
  const active = body.active;
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';

  if (!name || name.length > 120) fields.name = 'Enter a product name (1-120 characters).';
  if (!description || description.length > 2000) {
    fields.description = 'Enter a description (1-2000 characters).';
  }
  if (!category) fields.category = 'Choose Football, Cricket, or F1 / Racing.';
  if (!Number.isSafeInteger(price) || price < 1 || price > MAX_DATABASE_INTEGER) {
    fields.price = 'Enter a whole-number price greater than 0 BDT.';
  }
  if (typeof active !== 'boolean') fields.active = 'Choose whether this product is active.';

  let validImageUrl = imageUrl;
  if (validImageUrl) {
    const isLocalImage = validImageUrl.startsWith('/images/') &&
      !validImageUrl.startsWith('//') && !validImageUrl.includes('..');
    let isHttpsImage = false;
    try {
      const imageUrlObject = new URL(validImageUrl);
      isHttpsImage = imageUrlObject.protocol === 'https:' &&
        !imageUrlObject.username && !imageUrlObject.password;
    } catch {}
    if (validImageUrl.length > 2048 || (!isLocalImage && !isHttpsImage)) {
      fields.imageUrl = 'Use a secure https image URL or upload a PNG, JPEG, or WebP image.';
    }
  }
  if (body.imageFile !== undefined && body.imageFile !== null) {
    const imageValidation = validateProductImageFile(body.imageFile);
    if (imageValidation.error) fields.imageFile = imageValidation.error;
  } else if (!validImageUrl && !existing?.image && body.imageFile == null) {
    fields.imageUrl = 'Provide an image URL or upload an image.';
  }

  let sizes;
  let initialStock;
  if (creating) {
    sizes = body.sizes;
    initialStock = body.initialStock;
    if (!Array.isArray(sizes) || sizes.length < 1 ||
        sizes.some((size) => !PRODUCT_SIZES.includes(size)) ||
        new Set(sizes).size !== sizes.length) {
      fields.sizes = 'Select at least one supported size without duplicates.';
    } else if (!initialStock || typeof initialStock !== 'object' || Array.isArray(initialStock)) {
      fields.initialStock = 'Enter an initial stock quantity for every selected size.';
    } else {
      for (const size of sizes) {
        const quantity = initialStock[size];
        if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > MAX_DATABASE_INTEGER) {
          fields[`stock-${size}`] = `Enter a non-negative whole-number stock for size ${size}.`;
        }
      }
    }
  }

  if (Object.keys(fields).length) {
    return { error: 'Please correct the highlighted product details.', fields };
  }

  return {
    product: {
      ...(existing || {}),
      name,
      description,
      sport: category.sport,
      sportKey: category.sportKey,
      price,
      image: validImageUrl || existing?.image || '',
      badge: existing?.badge || '',
      featured: existing?.featured || false,
      active,
      ...(creating ? { sizes } : {}),
    },
    ...(creating ? { initialStock } : {}),
  };
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
  app.use('/api/admin/products', requireAdmin);
  app.use(['/api/orders', '/api/products', '/api/inventory', '/api/admin/products'], async (req, res, next) => {
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
    let products = (await getProductsCatalog(req.app.locals.orderStore))
      .filter((product) => product.active !== false);
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

  app.get('/api/admin/products', async (req, res) => {
    const store = req.app.locals.orderStore;
    if (typeof store.listProducts !== 'function') {
      return res.status(503).json({ error: 'Product management requires the Supabase product catalog migration.' });
    }
    const products = await store.listProducts();
    const inventory = await store.listInventory();
    const availabilityByProduct = new Map();
    inventory.forEach((row) => {
      const rows = availabilityByProduct.get(row.product_id) || [];
      rows.push({
        size: row.size,
        availableQuantity: Number(row.available_quantity),
      });
      availabilityByProduct.set(row.product_id, rows);
    });
    res.set('Cache-Control', 'no-store');
    return res.json(products.map((product) => ({
      ...product,
      availability: availabilityByProduct.get(product.id) || [],
    })));
  });

  app.post('/api/admin/products', async (req, res, next) => {
    const store = req.app.locals.orderStore;
    if (typeof store.createProduct !== 'function') {
      return res.status(503).json({ error: 'Product management requires the Supabase product catalog migration.' });
    }

    const validated = validateProductInput(req.body, { creating: true });
    if (!validated.product) {
      return res.status(400).json({
        error: validated.error,
        ...(validated.fields ? { fields: validated.fields } : {}),
      });
    }

    let uploadedImage = null;
    try {
      let image = validated.product.image;
      if (req.body.imageFile) {
        const file = validateProductImageFile(req.body.imageFile);
        if (file.error) {
          return res.status(400).json({ error: file.error, fields: { imageFile: file.error } });
        }
        if (typeof store.uploadProductImage !== 'function') {
          return res.status(503).json({ error: 'Image storage is not configured.' });
        }
        uploadedImage = await store.uploadProductImage(file.buffer, req.body.imageFile.contentType);
        image = uploadedImage.url;
      }

      const product = { ...validated.product, id: randomUUID(), image };
      await store.createProduct(product, validated.initialStock);
      return res.status(201).json({ message: 'Product created.', product });
    } catch (error) {
      if (uploadedImage && typeof store.deleteProductImage === 'function') {
        try {
          await store.deleteProductImage(uploadedImage.path);
        } catch (cleanupError) {
          console.error('Product image cleanup failed:', cleanupError.code || cleanupError.name || 'Error');
        }
      }
      return next(error);
    }
  });

  app.patch('/api/admin/products/:id', async (req, res, next) => {
    const store = req.app.locals.orderStore;
    if (typeof store.updateProduct !== 'function' || typeof store.listProducts !== 'function') {
      return res.status(503).json({ error: 'Product management requires the Supabase product catalog migration.' });
    }
    const existing = (await store.listProducts()).find((product) => product.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Product not found.' });

    const validated = validateProductInput(req.body, { existing, creating: false });
    if (!validated.product) {
      return res.status(400).json({
        error: validated.error,
        ...(validated.fields ? { fields: validated.fields } : {}),
      });
    }

    let uploadedImage = null;
    try {
      let image = validated.product.image;
      if (req.body.imageFile) {
        const file = validateProductImageFile(req.body.imageFile);
        if (file.error) {
          return res.status(400).json({ error: file.error, fields: { imageFile: file.error } });
        }
        if (typeof store.uploadProductImage !== 'function') {
          return res.status(503).json({ error: 'Image storage is not configured.' });
        }
        uploadedImage = await store.uploadProductImage(file.buffer, req.body.imageFile.contentType);
        image = uploadedImage.url;
      }

      const product = { ...validated.product, id: existing.id, image };
      const updated = await store.updateProduct(product);
      if (!updated) {
        if (uploadedImage && typeof store.deleteProductImage === 'function') {
          await store.deleteProductImage(uploadedImage.path);
          uploadedImage = null;
        }
        return res.status(404).json({ error: 'Product not found.' });
      }
      return res.json({ message: 'Product updated.', product });
    } catch (error) {
      if (uploadedImage && typeof store.deleteProductImage === 'function') {
        try {
          await store.deleteProductImage(uploadedImage.path);
        } catch (cleanupError) {
          console.error('Product image cleanup failed:', cleanupError.code || cleanupError.name || 'Error');
        }
      }
      return next(error);
    }
  });

  app.get('/api/inventory', async (req, res) => {
    const products = await getProductsCatalog(req.app.locals.orderStore);
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
    const product = (await getProductsCatalog(req.app.locals.orderStore))
      .find((item) => item.id === productId);
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

      const products = await getProductsCatalog(req.app.locals.orderStore);
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

    const products = await getProductsCatalog(req.app.locals.orderStore);
    const preparedOrder = prepareOrderInput(req.body, { ...req.body, email }, products);
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

    const products = await getProductsCatalog(req.app.locals.orderStore);
    const product = products.find((item) => item.id === order.product_id) ||
      products.find((item) => item.name === order.product);
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

    const products = await getProductsCatalog(req.app.locals.orderStore);
    const product = products.find((item) => item.id === order.product_id) ||
      products.find((item) => item.name === order.product);
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

    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'The request is too large. Product images must be 650 KB or smaller.' });
    }
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'The request body must contain valid JSON.' });
    }
    console.error('Request failed:', error.code || error.name || 'Error');
    if (error.code === 'P0001' && error.message === 'OUT_OF_STOCK') {
      return res.status(409).json({ error: 'The requested size no longer has enough stock.' });
    }
    if (error.code === 'P0001' && error.message === 'INVENTORY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Inventory is not initialized. Run supabase/schema.sql in the Supabase SQL Editor.' });
    }
    if (error.code === 'P0001' && error.message === 'PRODUCT_UNAVAILABLE') {
      return res.status(409).json({ error: 'A product in this order is no longer available.' });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A product with this identifier already exists.' });
    }
    if (error.code === '22023' || error.code === '23514') {
      return res.status(400).json({ error: 'The product or inventory details are invalid.' });
    }
    if (error.code === 'SUPABASE_NOT_CONFIGURED') {
      return res.status(503).json({ error: error.message });
    }
    if (String(error.resource || '').startsWith('storage/')) {
      return res.status(502).json({
        error: 'Product image upload failed. Check the product-images Storage bucket and try again.',
      });
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
    if (((error.code === 'PGRST205' || error.code === '42P01') &&
        error.resource === 'products') ||
        (error.code === 'PGRST202' &&
          ['rpc/create_product_with_inventory'].includes(error.resource))) {
      return res.status(503).json({
        error: 'The Supabase product catalog is not configured. Run supabase/schema.sql in the Supabase SQL Editor.',
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
