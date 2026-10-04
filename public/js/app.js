/**
 * JERZEE — Premium Sportswear Storefront Architecture
 * Modular Vanilla JavaScript Implementation
 */

// ==========================================================================
// 1. SPORTS CONFIGURATION (EXTENSIBLE ARCHITECTURE)
// Easily add Basketball, Tennis, etc. in future phases without redesigning.
// ==========================================================================
const AVAILABLE_SPORTS = [
  {
    key: 'football',
    name: 'Football',
    icon: '⚽',
    desc: 'Official club & international match kits with vapor-weave breathability.',
    tagline: 'Match & Fan Editions'
  },
  {
    key: 'cricket',
    name: 'Cricket',
    icon: '🏏',
    desc: 'Official national editions, Bengal Tiger graphics & dry-fit mesh.',
    tagline: 'Polo & Performance'
  },
  {
    key: 'racing',
    name: 'F1 / Racing',
    icon: '🏎️',
    desc: 'Motorsport crew kits with aerodynamic sleeves and high-def team crests.',
    tagline: 'Motorsport Team Wear'
  }
];

// Fallback products catalog if API is offline or during initial render
const FALLBACK_PRODUCTS = [
  {
    id: 'barcelona-away-2026',
    name: 'FC Barcelona 2026 Away Jersey',
    sport: 'Football',
    sportKey: 'football',
    price: 1200,
    image: '/images/products/barcelona.jpg',
    badge: 'Bestseller',
    description: 'Blaugrana heritage with engineered vapor-weave micro-mesh for peak match performance.',
    featured: true,
    sizes: ['S', 'M', 'L', 'XL', 'XXL']
  },
  {
    id: 'real-madrid-away-2026',
    name: 'Real Madrid 2026 Away Jersey',
    sport: 'Football',
    sportKey: 'football',
    price: 1200,
    image: '/images/products/real-madrid.jpg',
    badge: 'Top Pick',
    description: 'Sophisticated obsidian black away edition with metallic gold trim and aeroready comfort.',
    featured: true,
    sizes: ['S', 'M', 'L', 'XL', 'XXL']
  },
  {
    id: 'bangladesh-cricket-2026',
    name: 'Bangladesh National Cricket Jersey 2026',
    sport: 'Cricket',
    sportKey: 'cricket',
    price: 1150,
    image: '/images/products/bangladesh-cricket.jpg',
    badge: 'National Pride',
    description: 'Official Bengal Tiger edition with breathable moisture-control weave and athletic ribbed polo collar.',
    featured: true,
    sizes: ['S', 'M', 'L', 'XL', 'XXL']
  },
  {
    id: 'red-bull-racing-2026',
    name: 'Red Bull Racing Official Jersey 2026',
    sport: 'F1 / Racing',
    sportKey: 'racing',
    price: 1350,
    image: '/images/products/red-bull-f1.jpg',
    badge: 'F1 Official',
    description: 'High-octane motorsport crew kit with aerodynamic raglan sleeves and ergonomic side panels.',
    featured: true,
    sizes: ['S', 'M', 'L', 'XL', 'XXL']
  },
  {
    id: 'ferrari-racing-2026',
    name: 'Scuderia Ferrari F1 Team Jersey 2026',
    sport: 'F1 / Racing',
    sportKey: 'racing',
    price: 1350,
    image: '/images/products/ferrari-f1.svg',
    badge: 'Speed Icon',
    description: 'Iconic Rosso Corsa red racing silhouette with carbon-styled side panels and gold-piped accents.',
    featured: true,
    sizes: ['S', 'M', 'L', 'XL', 'XXL']
  },
  {
    id: 'bangladesh-football-2026',
    name: 'Bangladesh National Football Kit 2026',
    sport: 'Football',
    sportKey: 'football',
    price: 1100,
    image: '/images/products/bangladesh-football.svg',
    badge: 'New Season',
    description: 'Vibrant forest green match kit featuring dynamic scarlet chest disc and athletic flex hem.',
    featured: true,
    sizes: ['S', 'M', 'L', 'XL', 'XXL']
  }
];

// ==========================================================================
// 2. STATE STORE
// ==========================================================================
const AppState = {
  products: [...FALLBACK_PRODUCTS],
  selectedSizes: {},
  activeSportFilter: 'all',
  cart: JSON.parse(localStorage.getItem('jerzee_cart') || '[]'),
  currentCheckoutItems: null
};

// ==========================================================================
// 3. INITIALIZATION
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  initNavbar();
  initHeroVideo();
  initSportsCategories();
  fetchProducts();
  initCart();
  initSearch();
  initOrderModal();
  initNewsletter();
});

// ==========================================================================
// 4. NAVBAR & NAVIGATION
// ==========================================================================
function initNavbar() {
  const header = document.querySelector('.site-header');
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const mobileNavDrawer = document.getElementById('mobileNavDrawer');

  if (header) {
    // Sticky navbar shadow and dark blur on scroll
    window.addEventListener('scroll', () => {
      if (window.scrollY > 40) {
        header.classList.add('is-scrolled');
      } else {
        header.classList.remove('is-scrolled');
      }
    }, { passive: true });
  }

  // Mobile menu toggle
  if (hamburgerBtn && mobileNavDrawer) {
    hamburgerBtn.addEventListener('click', () => {
      const isOpen = mobileNavDrawer.classList.toggle('is-open');
      hamburgerBtn.setAttribute('aria-expanded', String(isOpen));
      hamburgerBtn.setAttribute('aria-label', isOpen ? 'Close Menu' : 'Open Menu');
    });

    // Close mobile drawer when link clicked
    mobileNavDrawer.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        mobileNavDrawer.classList.remove('is-open');
      });
    });
  }

  // Sports dropdown item clicks
  document.querySelectorAll('[data-nav-sport]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const sportKey = item.dataset.navSport;
      setSportFilter(sportKey);
      scrollToSection('products-section');
    });
  });
}

// ==========================================================================
// 5. HERO VIDEO BACKGROUND & FALLBACK
// ==========================================================================
function initHeroVideo() {
  const video = document.getElementById('heroVideo');
  const fallback = document.querySelector('.hero-bg-fallback');

  if (!video) return;

  // Handle video loading errors gracefully
  video.addEventListener('error', () => {
    if (fallback) fallback.style.display = 'block';
    video.style.display = 'none';
  });

  // Check if video actually plays
  const playPromise = video.play();
  if (playPromise !== undefined) {
    playPromise.catch(() => {
      // Autoplay was prevented or source not found; fallback remains visible
      if (fallback) fallback.style.display = 'block';
    });
  }
}

// ==========================================================================
// 6. SHOP BY SPORT (3 CARDS SECTION)
// ==========================================================================
function initSportsCategories() {
  const sportsGrid = document.getElementById('sportsGrid');
  if (!sportsGrid) return;

  sportsGrid.innerHTML = AVAILABLE_SPORTS.map(sport => `
    <div class="sport-card" data-sport-key="${sport.key}" role="button" tabindex="0">
      <div class="sport-card-icon">${sport.icon}</div>
      <h3 class="sport-card-name">${sport.name}</h3>
      <p class="sport-card-desc">${sport.desc}</p>
      <div class="sport-card-cta">
        <span>Shop Now</span>
        <span class="arrow">→</span>
      </div>
    </div>
  `).join('');

  // Click card to filter products
  sportsGrid.querySelectorAll('.sport-card').forEach(card => {
    card.addEventListener('click', () => {
      const sportKey = card.dataset.sportKey;
      setSportFilter(sportKey);
      scrollToSection('products-section');
    });
  });
}

// ==========================================================================
// 7. PRODUCT CATALOG & FETCHING
// ==========================================================================
async function fetchProducts() {
  try {
    const response = await fetch('/api/products');
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        AppState.products = data;
      }
    }
  } catch (err) {
    console.warn('JERZEE: Using built-in product catalog fallback.', err);
  }

  // Pre-select 'M' size for all products by default
  AppState.products.forEach(p => {
    if (!AppState.selectedSizes[p.id]) {
      AppState.selectedSizes[p.id] = 'M';
    }
  });

  renderProductFilters();
  renderProducts();
  populateOrderModalProductDropdown();
}

function renderProductFilters() {
  const filterTabsContainer = document.getElementById('filterTabs');
  if (!filterTabsContainer) return;

  const tabs = [
    { key: 'all', label: `All (${AppState.products.length})` },
    ...AVAILABLE_SPORTS.map(sport => {
      const count = AppState.products.filter(p => p.sportKey === sport.key).length;
      return {
        key: sport.key,
        label: `${sport.icon} ${sport.name} (${count})`
      };
    })
  ];

  filterTabsContainer.innerHTML = tabs.map(tab => `
    <button type="button" class="filter-tab ${AppState.activeSportFilter === tab.key ? 'active' : ''}" data-filter="${tab.key}">
      ${tab.label}
    </button>
  `).join('');

  filterTabsContainer.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      setSportFilter(btn.dataset.filter);
    });
  });
}

function setSportFilter(sportKey) {
  AppState.activeSportFilter = sportKey;
  renderProductFilters();
  renderProducts();
}

function renderProducts() {
  const grid = document.getElementById('productsGrid');
  if (!grid) return;

  const filtered = AppState.activeSportFilter === 'all'
    ? AppState.products
    : AppState.products.filter(p => p.sportKey === AppState.activeSportFilter);

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: var(--text-secondary);">
        <p style="font-size: 18px; margin-bottom: 12px;">No jerseys found for this category.</p>
        <button class="btn btn-secondary" onclick="setSportFilter('all')">View All Jerseys</button>
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered.map(product => {
    const selectedSize = AppState.selectedSizes[product.id] || 'M';
    const sizes = product.sizes || ['S', 'M', 'L', 'XL', 'XXL'];

    return `
      <article class="product-card" data-product-id="${product.id}">
        <div class="product-image-wrap">
          <img src="${product.image}" alt="${product.name}" class="product-img" loading="lazy" onerror="this.src='/images/products/barcelona.jpg'" />
          ${product.badge ? `<span class="product-badge">${product.badge}</span>` : ''}
          <span class="product-sport-tag">${product.sport}</span>
        </div>

        <div class="product-info">
          <h3 class="product-title">${product.name}</h3>
          <p class="product-desc">${product.description || 'Premium match kit with dry-wicking athletic mesh.'}</p>

          <div class="size-selector">
            <div class="size-label">
              <span>Select Size</span>
              <span class="accent-lime">${selectedSize}</span>
            </div>
            <div class="size-chips" data-product-id="${product.id}">
              ${sizes.map(size => `
                <button type="button" class="size-chip ${size === selectedSize ? 'selected' : ''}" data-size="${size}">
                  ${size}
                </button>
              `).join('')}
            </div>
          </div>

          <div class="product-footer">
            <div class="product-price">
              <span class="currency">৳</span>${Number(product.price).toLocaleString('en-BD')}
            </div>
            <div class="product-card-actions">
              <button type="button" class="btn-card-cart" data-action="cart" data-id="${product.id}" title="Add to Cart">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
                  <line x1="3" y1="6" x2="21" y2="6"></line>
                  <path d="M16 10a4 4 0 0 1-8 0"></path>
                </svg>
                <span>Add</span>
              </button>
              <button type="button" class="btn-card-order" data-action="order" data-id="${product.id}">
                Order
              </button>
            </div>
          </div>
        </div>
      </article>
    `;
  }).join('');

  // Attach size selector listeners
  grid.querySelectorAll('.size-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      const container = e.target.closest('.size-chips');
      const productId = container.dataset.productId;
      const size = e.target.dataset.size;
      AppState.selectedSizes[productId] = size;

      container.querySelectorAll('.size-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');

      const labelValue = chip.closest('.size-selector').querySelector('.size-label .accent-lime');
      if (labelValue) labelValue.textContent = size;
    });
  });

  // Attach Add to Cart & Quick Order listeners
  grid.querySelectorAll('[data-action="cart"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const product = AppState.products.find(p => p.id === id);
      const size = AppState.selectedSizes[id] || 'M';
      if (product) {
        addToCart(product, size);
      }
    });
  });

  grid.querySelectorAll('[data-action="order"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const product = AppState.products.find(p => p.id === id);
      const size = AppState.selectedSizes[id] || 'M';
      if (product) {
        openOrderModalWithProduct(product, size);
      }
    });
  });
}

// ==========================================================================
// 8. SHOPPING CART SYSTEM
// ==========================================================================
function initCart() {
  const cartTrigger = document.getElementById('cartTrigger');
  const cartCloseBtn = document.getElementById('cartCloseBtn');
  const cartBackdrop = document.getElementById('cartBackdrop');
  const cartDrawer = document.getElementById('cartDrawer');
  const cartCheckoutBtn = document.getElementById('cartCheckoutBtn');

  if (cartTrigger) {
    cartTrigger.addEventListener('click', openCart);
  }

  if (cartCloseBtn) {
    cartCloseBtn.addEventListener('click', closeCart);
  }

  if (cartBackdrop) {
    cartBackdrop.addEventListener('click', closeCart);
  }

  if (cartCheckoutBtn) {
    cartCheckoutBtn.addEventListener('click', () => {
      if (AppState.cart.length > 0) {
        const cartItems = AppState.cart.map(item => ({ ...item }));
        closeCart();
        openOrderModalForCart(cartItems);
      }
    });
  }

  updateCartUI();
}

function openCart() {
  const backdrop = document.getElementById('cartBackdrop');
  const drawer = document.getElementById('cartDrawer');
  if (backdrop && drawer) {
    backdrop.classList.add('is-open');
    drawer.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }
}

function closeCart() {
  const backdrop = document.getElementById('cartBackdrop');
  const drawer = document.getElementById('cartDrawer');
  if (backdrop && drawer) {
    backdrop.classList.remove('is-open');
    drawer.classList.remove('is-open');
    document.body.style.overflow = '';
  }
}

function addToCart(product, size = 'M', quantity = 1) {
  const existingIndex = AppState.cart.findIndex(
    item => item.id === product.id && item.size === size
  );

  if (existingIndex > -1) {
    AppState.cart[existingIndex].quantity += quantity;
  } else {
    AppState.cart.push({
      id: product.id,
      name: product.name,
      price: Number(product.price),
      size: size,
      quantity: quantity,
      image: product.image
    });
  }

  saveCart();
  updateCartUI();
  openCart();

  // Pulse badge
  const badge = document.getElementById('cartCount');
  if (badge) {
    badge.classList.remove('bump');
    void badge.offsetWidth; // trigger reflow
    badge.classList.add('bump');
  }
}

function removeFromCart(index) {
  AppState.cart.splice(index, 1);
  saveCart();
  updateCartUI();
}

function updateCartQuantity(index, delta) {
  if (!AppState.cart[index]) return;
  AppState.cart[index].quantity += delta;
  if (AppState.cart[index].quantity <= 0) {
    removeFromCart(index);
    return;
  }
  saveCart();
  updateCartUI();
}

function saveCart() {
  localStorage.setItem('jerzee_cart', JSON.stringify(AppState.cart));
}

function updateCartUI() {
  const badge = document.getElementById('cartCount');
  const itemsContainer = document.getElementById('cartItems');
  const subtotalEl = document.getElementById('cartSubtotal');
  const totalEl = document.getElementById('cartTotal');
  const checkoutBtn = document.getElementById('cartCheckoutBtn');

  const totalItems = AppState.cart.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = AppState.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  if (badge) {
    badge.textContent = totalItems;
  }

  if (subtotalEl) {
    subtotalEl.textContent = `৳${subtotal.toLocaleString('en-BD')}`;
  }

  if (totalEl) {
    totalEl.textContent = `৳${subtotal.toLocaleString('en-BD')}`;
  }

  if (checkoutBtn) {
    checkoutBtn.disabled = AppState.cart.length === 0;
  }

  if (!itemsContainer) return;

  if (AppState.cart.length === 0) {
    itemsContainer.innerHTML = `
      <div class="cart-empty-state">
        <div class="cart-empty-icon">🛍️</div>
        <h4 class="cart-empty-title">Your Cart is Empty</h4>
        <p class="cart-empty-desc">Discover our official football, cricket, and racing jerseys.</p>
        <button class="btn btn-primary" onclick="closeCart(); scrollToSection('products-section')">
          Explore Jerseys →
        </button>
      </div>
    `;
    return;
  }

  itemsContainer.innerHTML = AppState.cart.map((item, index) => `
    <div class="cart-item">
      <img src="${item.image}" alt="${item.name}" class="cart-item-img" onerror="this.src='/images/products/barcelona.jpg'" />
      <div class="cart-item-details">
        <div class="cart-item-title">${item.name}</div>
        <div class="cart-item-meta">
          Size: <span class="badge-size">${item.size}</span> • ৳${item.price.toLocaleString('en-BD')}
        </div>
        <div class="cart-item-actions">
          <div class="qty-control">
            <button type="button" class="qty-btn" onclick="updateCartQuantity(${index}, -1)">-</button>
            <span class="qty-val">${item.quantity}</span>
            <button type="button" class="qty-btn" onclick="updateCartQuantity(${index}, 1)">+</button>
          </div>
          <span class="cart-item-price">৳${(item.price * item.quantity).toLocaleString('en-BD')}</span>
          <button type="button" class="cart-item-remove" onclick="removeFromCart(${index})" title="Remove item">
            ✕
          </button>
        </div>
      </div>
    </div>
  `).join('');
}

// ==========================================================================
// 9. ORDER & CHECKOUT MODAL
// ==========================================================================
function initOrderModal() {
  const modal = document.getElementById('orderModal');
  const closeBtn = document.getElementById('orderCloseBtn');
  const backdrop = document.getElementById('orderBackdrop');
  const form = document.getElementById('orderForm');
  const productSelect = document.getElementById('orderProductSelect');
  const sizeSelect = document.getElementById('orderSizeSelect');
  const quantityInput = document.getElementById('orderQuantityInput');

  if (closeBtn) closeBtn.addEventListener('click', closeOrderModal);
  if (backdrop) backdrop.addEventListener('click', closeOrderModal);

  if (productSelect) productSelect.addEventListener('change', calculateOrderTotal);
  if (quantityInput) quantityInput.addEventListener('input', calculateOrderTotal);

  if (form) {
    form.addEventListener('submit', handleOrderSubmit);
  }
}

function populateOrderModalProductDropdown() {
  const select = document.getElementById('orderProductSelect');
  if (!select) return;

  select.innerHTML = AppState.products.map(p => `
    <option value="${p.name}" data-price="${p.price}">
      ${p.name} — ৳${Number(p.price).toLocaleString('en-BD')} (${p.sport})
    </option>
  `).join('');
}

function openOrderModalWithProduct(product, size = 'M', quantity = 1) {
  const modal = document.getElementById('orderModal');
  const select = document.getElementById('orderProductSelect');
  const sizeSelect = document.getElementById('orderSizeSelect');
  const quantityInput = document.getElementById('orderQuantityInput');
  const formMsg = document.getElementById('formMsg');
  const successView = document.getElementById('orderSuccessView');
  const form = document.getElementById('orderForm');

  if (!modal) return;
  AppState.currentCheckoutItems = null;
  setCartCheckoutMode(false);

  // Reset modal state
  if (formMsg) {
    formMsg.className = '';
    formMsg.style.display = 'none';
  }
  if (successView) successView.style.display = 'none';
  if (form) form.style.display = 'block';

  // Populate selection
  if (select) {
    for (let i = 0; i < select.options.length; i++) {
      if (select.options[i].value === product.name) {
        select.selectedIndex = i;
        break;
      }
    }
  }

  if (sizeSelect) {
    sizeSelect.value = size;
  }

  if (quantityInput) {
    quantityInput.value = quantity;
  }

  calculateOrderTotal();

  modal.classList.add('is-open');
  document.body.style.overflow = 'hidden';
}

function openOrderModalForCart(items) {
  const modal = document.getElementById('orderModal');
  const formMsg = document.getElementById('formMsg');
  const successView = document.getElementById('orderSuccessView');
  const form = document.getElementById('orderForm');

  if (!modal || items.length === 0) return;

  AppState.currentCheckoutItems = items;
  if (formMsg) {
    formMsg.className = '';
    formMsg.style.display = 'none';
  }
  if (successView) successView.style.display = 'none';
  if (form) form.style.display = 'block';

  const summaryItems = document.getElementById('cartOrderSummaryItems');
  if (summaryItems) {
    summaryItems.replaceChildren(...items.map((item) => {
      const row = document.createElement('div');
      row.className = 'order-summary-item';
      row.textContent = `${item.quantity} × ${item.name} (${item.size}) — ৳${(item.price * item.quantity).toLocaleString('en-BD')}`;
      return row;
    }));
  }

  setCartCheckoutMode(true);
  calculateOrderTotal();
  modal.classList.add('is-open');
  document.body.style.overflow = 'hidden';
}

function setCartCheckoutMode(isCartCheckout) {
  const productGroup = document.getElementById('orderProductGroup');
  const optionsGroup = document.getElementById('orderSingleItemOptions');
  const cartSummary = document.getElementById('cartOrderSummary');

  if (productGroup) {
    productGroup.hidden = isCartCheckout;
    productGroup.querySelector('select').disabled = isCartCheckout;
  }
  if (optionsGroup) {
    optionsGroup.hidden = isCartCheckout;
    optionsGroup.querySelectorAll('select, input').forEach((input) => {
      input.disabled = isCartCheckout;
    });
  }
  if (cartSummary) cartSummary.hidden = !isCartCheckout;
}

function closeOrderModal() {
  const modal = document.getElementById('orderModal');
  if (modal) {
    modal.classList.remove('is-open');
    document.body.style.overflow = '';
  }
}

function calculateOrderTotal() {
  const select = document.getElementById('orderProductSelect');
  const quantityInput = document.getElementById('orderQuantityInput');
  const hiddenTotal = document.getElementById('orderHiddenTotal');
  const displayTotal = document.getElementById('orderDisplayTotal');

  if (!select || !quantityInput) return;

  const total = AppState.currentCheckoutItems
    ? AppState.currentCheckoutItems.reduce((sum, item) => sum + item.price * item.quantity, 0)
    : Number(select.options[select.selectedIndex]?.dataset.price || 1200) *
      Math.max(1, parseInt(quantityInput.value, 10) || 1);

  if (hiddenTotal) hiddenTotal.value = total;
  if (displayTotal) displayTotal.textContent = `৳${total.toLocaleString('en-BD')}`;
}

async function handleOrderSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const formMsg = document.getElementById('formMsg');
  const successView = document.getElementById('orderSuccessView');

  calculateOrderTotal();

  const formData = new FormData(form);
  const payload = {
    customerName: formData.get('customerName'),
    email: formData.get('email'),
    phone: formData.get('phone'),
    address: formData.get('address')
  };
  const isCartCheckout = Array.isArray(AppState.currentCheckoutItems);
  if (isCartCheckout) {
    payload.items = AppState.currentCheckoutItems.map((item) => ({
      product: item.name,
      size: item.size,
      quantity: item.quantity,
      total: item.price * item.quantity
    }));
  } else {
    payload.product = formData.get('product');
    payload.size = formData.get('size');
    payload.quantity = Number(formData.get('quantity'));
    payload.total = Number(formData.get('total'));
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Processing Order...';

  try {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      if (formMsg) {
        formMsg.textContent = result.error || 'Failed to place order. Please review your details.';
        formMsg.className = 'error';
      }
      submitBtn.disabled = false;
      submitBtn.textContent = 'Place Order →';
      return;
    }

    // Success State
    if (form) form.style.display = 'none';
    if (successView) {
      const total = isCartCheckout
        ? payload.items.reduce((sum, item) => sum + item.total, 0)
        : payload.total;
      document.getElementById('orderSuccessId').textContent = isCartCheckout
        ? `Orders ${result.orderIds.map((id) => `#${id}`).join(', ')}`
        : `Order #${result.orderId}`;
      document.getElementById('orderSuccessSummary').textContent = isCartCheckout
        ? `${payload.items.length} item${payload.items.length === 1 ? '' : 's'} — ৳${total.toLocaleString('en-BD')}`
        : `${payload.quantity}x ${payload.product} (${payload.size}) — ৳${total.toLocaleString('en-BD')}`;
      successView.style.display = 'block';
    }

    if (isCartCheckout) {
      AppState.cart = [];
      saveCart();
      updateCartUI();
    }

  } catch (err) {
    if (formMsg) {
      formMsg.textContent = 'Network error. Please check your connection and retry.';
      formMsg.className = 'error';
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Place Order →';
  }
}

// ==========================================================================
// 10. LIVE SEARCH MODAL (SEARCH BY NAME, CLUB, SPORT)
// ==========================================================================
function initSearch() {
  const searchTrigger = document.getElementById('searchTrigger');
  const searchModal = document.getElementById('searchModal');
  const searchBackdrop = document.getElementById('searchBackdrop');
  const searchInput = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');

  if (searchTrigger) {
    searchTrigger.addEventListener('click', openSearch);
  }

  if (searchBackdrop) {
    searchBackdrop.addEventListener('click', closeSearch);
  }

  // Keyboard shortcut: '/' or 'Ctrl+K' opens search, 'Escape' closes
  document.addEventListener('keydown', (e) => {
    const searchModal = document.getElementById('searchModal');
    const searchIsOpen = searchModal && searchModal.classList.contains('is-open');

    if ((e.key === '/' || (e.ctrlKey && e.key.toLowerCase() === 'k')) && !searchIsOpen) {
      if (!['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        openSearch();
      }
    } else if (e.key === 'Escape') {
      closeSearch();
      closeCart();
      closeOrderModal();
    }
  });

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      performSearch(e.target.value);
    });
  }
}

function openSearch() {
  const modal = document.getElementById('searchModal');
  const input = document.getElementById('searchInput');
  if (modal) {
    modal.classList.add('is-open');
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 50);
      performSearch('');
    }
    document.body.style.overflow = 'hidden';
  }
}

function closeSearch() {
  const modal = document.getElementById('searchModal');
  if (modal) {
    modal.classList.remove('is-open');
    document.body.style.overflow = '';
  }
}

function performSearch(query) {
  const container = document.getElementById('searchResults');
  if (!container) return;

  const trimmed = query.trim().toLowerCase();

  const results = AppState.products.filter(p => {
    if (!trimmed) return true;
    return p.name.toLowerCase().includes(trimmed) ||
           (p.sport && p.sport.toLowerCase().includes(trimmed)) ||
           (p.description && p.description.toLowerCase().includes(trimmed));
  });

  if (results.length === 0) {
    container.innerHTML = `
      <div class="search-empty">
        No jerseys found matching "<strong>${escapeHtml(query)}</strong>".<br>
        Search for Barcelona, Real Madrid, Bangladesh, Ferrari, or Red Bull.
      </div>
    `;
    return;
  }

  container.innerHTML = results.map(product => `
    <div class="search-result-item" data-id="${product.id}">
      <img src="${product.image}" alt="${product.name}" class="search-result-thumb" onerror="this.src='/images/products/barcelona.jpg'" />
      <div class="search-result-info">
        <div class="search-result-name">${product.name}</div>
        <div class="search-result-sport">${product.sport}</div>
      </div>
      <div class="search-result-price">৳${Number(product.price).toLocaleString('en-BD')}</div>
    </div>
  `).join('');

  container.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.id;
      const product = AppState.products.find(p => p.id === id);
      closeSearch();
      if (product) {
        setSportFilter('all');
        scrollToSection('products-section');
        // Highlight card
        setTimeout(() => {
          const card = document.querySelector(`[data-product-id="${id}"]`);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.style.borderColor = 'var(--accent-lime)';
            card.style.boxShadow = '0 0 30px rgba(182, 255, 0, 0.4)';
            setTimeout(() => {
              card.style.borderColor = '';
              card.style.boxShadow = '';
            }, 2500);
          }
        }, 300);
      }
    });
  });
}

// ==========================================================================
// 11. NEWSLETTER & UTILITIES
// ==========================================================================
function initNewsletter() {
  const form = document.getElementById('newsletterForm');
  const feedback = document.getElementById('newsletterFeedback');

  if (form && feedback) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = form.querySelector('.newsletter-input');
      if (input && input.value) {
        feedback.style.display = 'block';
        feedback.style.color = 'var(--accent-lime)';
        feedback.textContent = `Welcome to the JERZEE VIP drop list! Updates sent to ${input.value}`;
        form.reset();
        setTimeout(() => { feedback.style.display = 'none'; }, 5000);
      }
    });
  }
}

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
