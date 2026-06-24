// 购物车管理
const CART_KEY = 'booming_cart';

// 获取购物车
function getCart() {
  const cart = localStorage.getItem(CART_KEY);
  return cart ? JSON.parse(cart) : [];
}

// 保存购物车
function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartBadge();
}

// 添加到购物车
function addToCart(product, tierIndex = -1, duration = '永久授权') {
  const cart = getCart();

  // 检查是否已存在
  const existingIndex = cart.findIndex(item =>
    item.productId === product.id && item.tierIndex === tierIndex
  );

  if (existingIndex >= 0) {
    // 已存在，增加数量
    cart[existingIndex].quantity += 1;
  } else {
    // 新增
    // 注意：API返回的是pricingTiers（驼峰），但产品对象可能是pricing_tiers或pricingTiers
    const pricingTiers = product.pricingTiers || product.pricing_tiers;
    const price = tierIndex >= 0 && pricingTiers && pricingTiers[tierIndex]
      ? pricingTiers[tierIndex].price
      : product.price;

    cart.push({
      productId: product.id,
      name: product.name,
      icon: product.icon || '📦',
      price: price,
      duration: duration,
      tierIndex: tierIndex,
      quantity: 1
    });
  }

  saveCart(cart);
  showCartNotification('已添加到购物车');
}

// 从购物车移除
function removeFromCart(productId, tierIndex) {
  let cart = getCart();
  cart = cart.filter(item => !(item.productId === productId && item.tierIndex === tierIndex));
  saveCart(cart);
  renderCartModal();
}

// 更新数量
function updateQuantity(productId, tierIndex, delta) {
  const cart = getCart();
  const index = cart.findIndex(item =>
    item.productId === productId && item.tierIndex === tierIndex
  );

  if (index >= 0) {
    cart[index].quantity += delta;
    if (cart[index].quantity <= 0) {
      cart.splice(index, 1);
    }
    saveCart(cart);
    renderCartModal();
  }
}

// 清空购物车
function clearCart() {
  localStorage.removeItem(CART_KEY);
  updateCartBadge();
}

// 计算总价
function getCartTotal() {
  const cart = getCart();
  return cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
}

// 更新购物车徽章
function updateCartBadge() {
  const cart = getCart();
  const badge = document.getElementById('cart-badge');
  if (badge) {
    const count = cart.reduce((sum, item) => sum + item.quantity, 0);
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }
}

// 显示提示 (XSS-safe: textContent, no innerHTML)
function showCartNotification(message) {
  const notification = document.createElement('div');
  notification.className = 'cart-notification';
  const icon = document.createElement('span');
  icon.textContent = '✓';
  notification.appendChild(icon);
  notification.appendChild(document.createTextNode(' ' + String(message || '')));
  notification.style.cssText = `
    position: fixed;
    top: 100px;
    right: 20px;
    background: #10b981;
    color: white;
    padding: 15px 25px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 10000;
    animation: slideIn 0.3s ease;
  `;
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 2000);
}

// Build empty-cart placeholder (XSS-safe: static text only)
function buildEmptyCart() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'text-align: center; padding: 40px 20px;';

  const icon = document.createElement('div');
  icon.style.cssText = 'font-size: 48px; margin-bottom: 15px;';
  icon.textContent = '🛒';
  wrap.appendChild(icon);

  const msg = document.createElement('p');
  msg.style.cssText = 'color: var(--text-light); margin-bottom: 20px;';
  msg.textContent = '购物车是空的';
  wrap.appendChild(msg);

  const link = document.createElement('a');
  link.setAttribute('href', '/');
  link.className = 'btn btn-primary';
  link.textContent = '去选购';
  link.addEventListener('click', closeCartModal);
  wrap.appendChild(link);

  return wrap;
}

// Build a single cart item row (XSS-safe: data-* attrs + event delegation)
function buildCartItemRow(item) {
  const row = document.createElement('div');
  row.className = 'cart-item';
  // Coerce to safe primitives — localStorage is attacker-controlled.
  const productId = String(item.productId).slice(0, 32);
  const tierIndex = Number.isFinite(item.tierIndex) ? item.tierIndex : -1;
  row.setAttribute('data-product-id', productId);
  row.setAttribute('data-tier-index', String(tierIndex));

  const icon = document.createElement('div');
  icon.className = 'cart-item-icon';
  icon.textContent = String(item.icon || '📦').slice(0, 8);
  row.appendChild(icon);

  const info = document.createElement('div');
  info.className = 'cart-item-info';
  const name = document.createElement('div');
  name.className = 'cart-item-name';
  name.textContent = String(item.name || '').slice(0, 200);
  info.appendChild(name);
  const meta = document.createElement('div');
  meta.className = 'cart-item-meta';
  meta.textContent = String(item.duration || '').slice(0, 100);
  info.appendChild(meta);
  const price = document.createElement('div');
  price.className = 'cart-item-price';
  const numPrice = Number(item.price) || 0;
  price.textContent = `¥${numPrice.toFixed(2)}`;
  info.appendChild(price);
  row.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'cart-item-actions';

  const qty = document.createElement('div');
  qty.className = 'quantity-control';
  const minus = document.createElement('button');
  minus.textContent = '-';
  minus.setAttribute('data-cart-action', 'dec');
  const qtySpan = document.createElement('span');
  qtySpan.textContent = String(Math.max(0, Math.floor(Number(item.quantity) || 0)));
  const plus = document.createElement('button');
  plus.textContent = '+';
  plus.setAttribute('data-cart-action', 'inc');
  qty.appendChild(minus);
  qty.appendChild(qtySpan);
  qty.appendChild(plus);
  actions.appendChild(qty);

  const remove = document.createElement('button');
  remove.className = 'cart-item-remove';
  remove.textContent = '删除';
  remove.setAttribute('data-cart-action', 'remove');
  actions.appendChild(remove);

  row.appendChild(actions);
  return row;
}

// Build the cart footer (totals + checkout link)
function buildCartFooter(total) {
  const footer = document.createElement('div');
  footer.className = 'cart-footer';

  const totalEl = document.createElement('div');
  totalEl.className = 'cart-total';
  totalEl.appendChild(document.createTextNode('合计：'));
  const totalSpan = document.createElement('span');
  totalSpan.textContent = `¥${Number(total || 0).toFixed(2)}`;
  totalEl.appendChild(totalSpan);
  footer.appendChild(totalEl);

  const checkout = document.createElement('a');
  checkout.setAttribute('href', '/checkout.html');
  checkout.className = 'btn btn-primary';
  checkout.textContent = '去结算';
  checkout.addEventListener('click', closeCartModal);
  footer.appendChild(checkout);

  return footer;
}

// 渲染购物车弹窗 (XSS-safe: DOM API, no innerHTML with localStorage data)
function renderCartModal() {
  const cart = getCart();
  const modal = document.getElementById('cart-modal');
  const content = document.getElementById('cart-content');

  if (!modal || !content) return;

  content.replaceChildren();

  if (cart.length === 0) {
    content.appendChild(buildEmptyCart());
  } else {
    const total = getCartTotal();
    const items = document.createElement('div');
    items.className = 'cart-items';
    for (const item of cart) {
      items.appendChild(buildCartItemRow(item));
    }
    content.appendChild(items);
    content.appendChild(buildCartFooter(total));
  }

  modal.classList.add('active');
}

// 事件委托: 在 cart-content 内捕获 quantity / remove 按钮
function handleCartContentClick(event) {
  const target = event.target.closest('[data-cart-action]');
  if (!target) return;
  const row = target.closest('.cart-item');
  if (!row) return;
  const productId = row.getAttribute('data-product-id');
  const tierIndex = parseInt(row.getAttribute('data-tier-index') || '-1', 10);
  if (!productId) return;
  const action = target.getAttribute('data-cart-action');
  if (action === 'inc') updateQuantity(productId, tierIndex, 1);
  else if (action === 'dec') updateQuantity(productId, tierIndex, -1);
  else if (action === 'remove') removeFromCart(productId, tierIndex);
}

// 关闭购物车弹窗
function closeCartModal() {
  const modal = document.getElementById('cart-modal');
  if (modal) {
    modal.classList.remove('active');
  }
}

// 初始化购物车
document.addEventListener('DOMContentLoaded', function() {
  updateCartBadge();

  // 点击购物车图标打开弹窗
  const cartBtn = document.getElementById('cart-btn');
  if (cartBtn) {
    cartBtn.addEventListener('click', (e) => {
      e.preventDefault();
      renderCartModal();
    });
  }

  // 点击弹窗外部关闭
  const modal = document.getElementById('cart-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeCartModal();
      }
    });
  }

  // 事件委托: 处理购物车项的 +/-/删除 (避免 inline onclick)
  const content = document.getElementById('cart-content');
  if (content) {
    content.addEventListener('click', handleCartContentClick);
  }
});

// CSS动画
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes slideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }
`;
document.head.appendChild(style);
