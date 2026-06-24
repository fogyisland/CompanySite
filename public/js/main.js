// Main JavaScript for Booming Tech Sales Website

// Icon mapping
const iconMap = {
  code: 'C',
  palette: 'P',
  shield: 'S',
  check: 'K',
  cloud: 'O',
  image: 'I',
  software: 'S'
};

function getIcon(iconName) {
  return iconMap[iconName] || 'S';
}

// Load site settings
async function loadSettings() {
  try {
    const response = await fetch('/api/settings');
    const settings = await response.json();

    // Update header
    if (settings.companyName) {
      document.getElementById('header-logo-text').textContent = settings.companyName;
      document.getElementById('footer-brand-name').textContent = settings.companyName;
      document.getElementById('footer-copyright').textContent = settings.companyName;
      document.title = settings.companyName + ' - 专业软件商城';
      // Update features section title
      const featuresTitle = document.getElementById('features-title');
      if (featuresTitle) {
        featuresTitle.textContent = '为什么选择 ' + settings.companyName + '？';
      }
    }

    if (settings.description) {
      document.getElementById('footer-brand-desc').textContent = settings.description;
    }

    if (settings.logo) {
      const logoIcon = document.getElementById('header-logo-icon');
      logoIcon.outerHTML = '<img src="' + settings.logo + '" alt="Logo" style="height:40px;width:auto;">';
    }

    // Load banners
    if (settings.banners && settings.banners.length > 0) {
      renderBanners(settings.banners);
    } else {
      document.getElementById('banners').style.display = 'none';
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

// Render banners (XSS-safe: DOM API, no innerHTML with admin-controlled fields)
function renderBanners(banners) {
  const track = document.getElementById('banners-track');
  if (!track) return;
  track.replaceChildren();

  // Duplicate banners for seamless scroll
  const allBanners = [...banners, ...banners];

  for (const banner of allBanners) {
    const card = document.createElement('div');
    card.className = 'banner-scroll-card';

    const imgWrap = document.createElement('div');
    imgWrap.className = 'banner-scroll-img';
    if (banner.image) {
      const img = document.createElement('img');
      img.setAttribute('src', banner.image);
      img.setAttribute('alt', banner.title || 'Banner');
      imgWrap.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = 'display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-light); font-size: 14px;';
      placeholder.textContent = '暂无图片';
      imgWrap.appendChild(placeholder);
    }
    card.appendChild(imgWrap);

    const content = document.createElement('div');
    content.className = 'banner-scroll-content';
    if (banner.title) {
      const h3 = document.createElement('h3');
      h3.textContent = banner.title;
      content.appendChild(h3);
    }
    if (banner.description) {
      const p = document.createElement('p');
      p.textContent = banner.description;
      content.appendChild(p);
    }
    const btn = document.createElement('a');
    btn.setAttribute('href', '#products');
    btn.className = 'banner-scroll-btn';
    btn.textContent = '详情';
    content.appendChild(btn);

    card.appendChild(content);
    track.appendChild(card);
  }
}

// Build a product header (icon + name link + category)
function buildProductHeader(product) {
  const header = document.createElement('div');
  header.className = 'product-header';

  const icon = document.createElement('div');
  icon.className = 'product-icon';
  icon.textContent = getIcon(product.icon);
  header.appendChild(icon);

  const title = document.createElement('div');
  title.className = 'product-title';
  const h3 = document.createElement('h3');
  const nameLink = document.createElement('a');
  nameLink.setAttribute('href', `/product/${product.id}`);
  nameLink.style.cssText = 'color: inherit; text-decoration: none;';
  nameLink.textContent = product.name;
  h3.appendChild(nameLink);
  title.appendChild(h3);
  const catSpan = document.createElement('span');
  catSpan.textContent = product.category || '';
  title.appendChild(catSpan);
  header.appendChild(title);

  return header;
}

// Build a complete product card wrapper, used by both pricing-tier and single-price variants
function buildProductCard(product) {
  const card = document.createElement('div');
  card.className = 'product-card';
  // data-product-id enables CSS-escaped querySelector fallback in addProductToCart
  card.setAttribute('data-product-id', String(product.id));
  return card;
}

// Build meta line (version + platform)
function buildProductMeta(product) {
  const meta = document.createElement('div');
  meta.className = 'product-meta';
  const verSpan = document.createElement('span');
  verSpan.textContent = `版本: ${product.version || ''}`;
  const platSpan = document.createElement('span');
  platSpan.textContent = `平台: ${product.platform || ''}`;
  meta.appendChild(verSpan);
  meta.appendChild(platSpan);
  return meta;
}

// Render a product card with multiple pricing tiers
function buildPricingTierCard(product) {
  const card = buildProductCard(product);

  card.appendChild(buildProductHeader(product));

  const body = document.createElement('div');
  body.className = 'product-body';

  const desc = document.createElement('div');
  desc.className = 'product-description';
  desc.textContent = product.description || '';
  body.appendChild(desc);

  body.appendChild(buildProductMeta(product));

  const tiers = document.createElement('div');
  tiers.className = 'product-pricing-tiers';
  tiers.style.margin = '15px 0';
  product.pricingTiers.forEach((tier, index) => {
    const btn = document.createElement('button');
    btn.className = 'duration-btn' + (index === 0 ? ' active' : '');
    btn.setAttribute('data-tier-index', String(index));
    btn.addEventListener('click', () => showPrice(btn, index));
    btn.appendChild(document.createTextNode(tier.label + ' '));
    const priceSpan = document.createElement('span');
    priceSpan.className = 'duration-price';
    priceSpan.textContent = `¥${tier.price}`;
    btn.appendChild(priceSpan);
    tiers.appendChild(btn);
  });
  body.appendChild(tiers);

  const actions = document.createElement('div');
  actions.className = 'product-actions';
  actions.style.marginTop = '15px';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn-add-cart';
  addBtn.textContent = '加入购物车';
  // Pass card via closure so addProductToCart can find it without DOM query
  addBtn.addEventListener('click', () => addProductToCart(product.id, card));
  actions.appendChild(addBtn);
  body.appendChild(actions);

  card.appendChild(body);
  return card;
}

// Render a product card with single price
function buildSinglePriceCard(product) {
  const card = buildProductCard(product);

  card.appendChild(buildProductHeader(product));

  const body = document.createElement('div');
  body.className = 'product-body';

  const desc = document.createElement('div');
  desc.className = 'product-description';
  desc.textContent = product.description || '';
  body.appendChild(desc);

  body.appendChild(buildProductMeta(product));

  const footer = document.createElement('div');
  footer.className = 'product-footer';
  const price = document.createElement('div');
  price.className = 'product-price';
  price.appendChild(document.createTextNode(`¥${product.price}`));
  const suffix = document.createElement('span');
  suffix.textContent = ' 一次购买';
  price.appendChild(suffix);
  footer.appendChild(price);

  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.gap = '10px';
  const detailLink = document.createElement('a');
  detailLink.setAttribute('href', `/product/${product.id}`);
  detailLink.className = 'btn btn-outline';
  detailLink.textContent = '查看详情';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn-add-cart';
  addBtn.textContent = '加入购物车';
  addBtn.addEventListener('click', () => addProductToCart(product.id, card));
  btnRow.appendChild(detailLink);
  btnRow.appendChild(addBtn);
  footer.appendChild(btnRow);

  body.appendChild(footer);
  card.appendChild(body);
  return card;
}

// Render products (XSS-safe: DOM API, no innerHTML with admin/user-controlled fields)
function renderProducts(products) {
  const grid = document.getElementById('products-grid');
  if (!grid) return;
  grid.replaceChildren();

  if (!products || products.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const eh = document.createElement('h3');
    eh.textContent = '暂无产品';
    const ep = document.createElement('p');
    ep.textContent = '请稍后再来查看新产品。';
    empty.appendChild(eh);
    empty.appendChild(ep);
    grid.appendChild(empty);
    return;
  }

  for (const product of products) {
    const hasPricingTiers = product.pricingTiers && product.pricingTiers.length > 0;
    if (hasPricingTiers) {
      grid.appendChild(buildPricingTierCard(product));
    } else {
      grid.appendChild(buildSinglePriceCard(product));
    }
  }
}

// Load products from API
async function loadProducts() {
  try {
    const response = await fetch('/api/products');
    const data = await response.json();
    const products = Array.isArray(data) ? data : (data.products || []);
    renderProducts(products);
  } catch (error) {
    console.error('Error loading products:', error);
    document.getElementById('products-grid').innerHTML = `
      <div class="empty-state">
        <h3>加载产品失败</h3>
        <p>请刷新页面或稍后再试。</p>
      </div>
    `;
  }
}

// Buy product - redirect to checkout
function buyProduct(id, tierIndex) {
  if (tierIndex !== undefined) {
    window.location.href = '/checkout?productId=' + id + '&tierIndex=' + tierIndex;
  } else {
    window.location.href = '/checkout?productId=' + id;
  }
}

// Check user auth and update header
async function checkUserAuth() {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'include' });
    const data = await response.json();

    const topBar = document.querySelector('.top-bar .container');
    if (topBar) {
      if (data.loggedIn) {
        topBar.innerHTML = `
          <a href="/">技术支持</a>
          <a href="/user-center">用户中心</a>
          <a href="#" onclick="userLogout()">退出</a>
        `;
      } else {
        topBar.innerHTML = `
          <a href="#">技术支持</a>
          <a href="#">联系我们</a>
          <a href="/login">登录</a>
        `;
      }
    }
  } catch (error) {
    console.error('Error checking auth:', error);
  }
}

// User logout
async function userLogout() {
  try {
    await fetch('/api/user/logout', {
      method: 'POST',
      credentials: 'include'
    });
    window.location.reload();
  } catch (error) {
    console.error('Error logging out:', error);
  }
}

// Show price when clicking duration button
// (label/price removed from signature — they came from admin-controlled data;
//  the visual label/price is already rendered into the button, so we only
//  need to track the active tier index here)
function showPrice(btn, tierIndex) {
  const card = btn.closest('.product-card');
  card.querySelectorAll('.duration-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  card.dataset.selectedTier = tierIndex;
}

// Add product to cart
// cardRef: optional, the .product-card element (passed via closure from addEventListener)
//          If omitted, we walk up from the clicked button (legacy path).
async function addProductToCart(productId, cardRef) {
  try {
    const response = await fetch('/api/products/' + productId);
    const product = await response.json();

    // Find the card: prefer explicit ref, else walk from event target
    let card = cardRef;
    if (!card && typeof event !== 'undefined' && event && event.target) {
      card = event.target.closest('.product-card');
    }
    if (!card) {
      // Last-resort fallback: query by data attribute (must be set on the card)
      card = document.querySelector(`.product-card[data-product-id="${CSS.escape(String(productId))}"]`);
    }

    const pricingTiers = product.pricingTiers || product.pricing_tiers;

    if (pricingTiers && pricingTiers.length > 0) {
      const selectedTier = card ? card.dataset.selectedTier : undefined;
      if (selectedTier !== undefined) {
        const tierIndex = parseInt(selectedTier);
        const tier = pricingTiers[tierIndex];
        addToCart(product, tierIndex, tier ? tier.label : '基础方案');
      } else {
        addToCart(product, -1, '基础方案');
      }
    } else {
      addToCart(product, -1, '永久授权');
    }
  } catch (error) {
    console.error('Error adding to cart:', error);
    alert('添加失败，请稍后重试');
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadProducts();
  checkUserAuth();
  initScrollAnimations();
});

// ============================================
// Scroll-triggered Animation Observer
// ============================================

function initScrollAnimations() {
  // Create Observer
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.15,
    rootMargin: '0px 0px -50px 0px'
  });

  // Observe all fade-in elements
  document.querySelectorAll('.fade-in').forEach(el => {
    observer.observe(el);
  });

  // Apply stagger delays to product cards (if in DOM)
  const productCards = document.querySelectorAll('.product-card');
  productCards.forEach((card, index) => {
    const staggerClass = `stagger-${Math.min(index + 1, 9)}`;
    card.classList.add('fade-in', staggerClass);
    observer.observe(card);
  });
}
