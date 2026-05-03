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

// Render banners
function renderBanners(banners) {
  const track = document.getElementById('banners-track');

  // Duplicate banners for seamless scroll
  const allBanners = [...banners, ...banners];

  track.innerHTML = allBanners.map((banner, index) => `
    <div class="banner-scroll-card">
      <div class="banner-scroll-img">
        ${banner.image ? '<img src="' + banner.image + '" alt="' + (banner.title || 'Banner') + '">' : '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-light); font-size: 14px;">暂无图片</div>'}
      </div>
      <div class="banner-scroll-content">
        ${banner.title ? '<h3>' + banner.title + '</h3>' : ''}
        ${banner.description ? '<p>' + banner.description + '</p>' : ''}
        <a href="#products" class="banner-scroll-btn">详情</a>
      </div>
    </div>
  `).join('');
}

// Render products
function renderProducts(products) {
  const grid = document.getElementById('products-grid');

  if (!products || products.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <h3>暂无产品</h3>
        <p>请稍后再来查看新产品。</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = products.map(product => {
    const hasPricingTiers = product.pricingTiers && product.pricingTiers.length > 0;

    if (hasPricingTiers) {
      // 显示多价格方案 - 点击只显示价格，不跳转
      // 添加基础方案（使用product.price作为基础价格）
      const tierButtons = product.pricingTiers.map((tier, index) =>
        `<button class="duration-btn ${index === 0 ? 'active' : ''}" data-tier-index="${index}" onclick="showPrice(this, '${tier.label}', ${tier.price}, ${index})">
           ${tier.label} <span class="duration-price">¥${tier.price}</span>
         </button>`
      ).join('');
      return `
        <div class="product-card">
          <div class="product-header">
            <div class="product-icon">${getIcon(product.icon)}</div>
            <div class="product-title">
              <h3><a href="/product/${product.id}" style="color: inherit; text-decoration: none;">${product.name}</a></h3>
              <span>${product.category}</span>
            </div>
          </div>
          <div class="product-body">
            <div class="product-description">${product.description || ''}</div>
            <div class="product-meta">
              <span>版本: ${product.version}</span>
              <span>平台: ${product.platform}</span>
            </div>
            <div class="product-pricing-tiers" style="margin: 15px 0;">
              ${tierButtons}
            </div>
            <div class="product-actions" style="margin-top: 15px;">
              <button class="btn-add-cart" onclick="addProductToCart(${product.id})">加入购物车</button>
            </div>
          </div>
        </div>
      `;
    } else {
      // 单价格显示
      return `
        <div class="product-card">
          <div class="product-header">
            <div class="product-icon">${getIcon(product.icon)}</div>
            <div class="product-title">
              <h3><a href="/product/${product.id}" style="color: inherit; text-decoration: none;">${product.name}</a></h3>
              <span>${product.category}</span>
            </div>
          </div>
          <div class="product-body">
            <div class="product-description">${product.description || ''}</div>
            <div class="product-meta">
              <span>版本: ${product.version}</span>
              <span>平台: ${product.platform}</span>
            </div>
            <div class="product-footer">
              <div class="product-price">¥${product.price}<span> 一次购买</span></div>
              <div style="display: flex; gap: 10px;">
                <a href="/product/${product.id}" class="btn btn-outline">查看详情</a>
                <button class="btn-add-cart" onclick="addProductToCart(${product.id})">加入购物车</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }
  }).join('');
}

// Load products from API
async function loadProducts() {
  try {
    const response = await fetch('/api/products');
    const products = await response.json();
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
    const response = await fetch('/api/user/check-auth', { credentials: 'include' });
    const data = await response.json();

    const topBar = document.querySelector('.top-bar .container');
    if (topBar) {
      if (data.isUser) {
        topBar.innerHTML = `
          <a href="/">技术支持</a>
          <a href="/user-center">用户中心</a>
          <a href="#" onclick="userLogout()">退出</a>
        `;
      } else {
        topBar.innerHTML = `
          <a href="#">技术支持</a>
          <a href="#">联系我们</a>
          <a href="/user-login">登录</a>
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
function showPrice(btn, label, price, tierIndex) {
  // Remove active class from all duration buttons in this card
  const card = btn.closest('.product-card');
  card.querySelectorAll('.duration-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // Store selected tier index in card data attribute
  card.dataset.selectedTier = tierIndex;
}

// Add product to cart
async function addProductToCart(productId) {
  try {
    const response = await fetch('/api/products/' + productId);
    const product = await response.json();

    // Check if product has pricing tiers (API返回pricingTiers)
    const card = document.querySelector(`button[onclick="addProductToCart(${productId})"]`).closest('.product-card');
    const pricingTiers = product.pricingTiers || product.pricing_tiers;

    if (pricingTiers && pricingTiers.length > 0) {
      // Get selected tier from card data attribute
      const selectedTier = card.dataset.selectedTier;
      if (selectedTier !== undefined) {
        const tierIndex = parseInt(selectedTier);
        const tier = pricingTiers[tierIndex];
        addToCart(product, tierIndex, tier.label);
      } else {
        // No tier selected, use base price (tierIndex = -1)
        addToCart(product, -1, '基础方案');
      }
    } else {
      // No tiers, add with default
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
});
