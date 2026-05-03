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

// 显示提示
function showCartNotification(message) {
  const notification = document.createElement('div');
  notification.className = 'cart-notification';
  notification.innerHTML = `<span>✓</span> ${message}`;
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

// 渲染购物车弹窗
function renderCartModal() {
  const cart = getCart();
  const modal = document.getElementById('cart-modal');
  const content = document.getElementById('cart-content');

  if (!modal || !content) return;

  if (cart.length === 0) {
    content.innerHTML = `
      <div style="text-align: center; padding: 40px 20px;">
        <div style="font-size: 48px; margin-bottom: 15px;">🛒</div>
        <p style="color: var(--text-light); margin-bottom: 20px;">购物车是空的</p>
        <a href="/" class="btn btn-primary" onclick="closeCartModal()">去选购</a>
      </div>
    `;
  } else {
    const total = getCartTotal();
    content.innerHTML = `
      <div class="cart-items">
        ${cart.map(item => `
          <div class="cart-item">
            <div class="cart-item-icon">${item.icon}</div>
            <div class="cart-item-info">
              <div class="cart-item-name">${item.name}</div>
              <div class="cart-item-meta">${item.duration}</div>
              <div class="cart-item-price">¥${item.price}</div>
            </div>
            <div class="cart-item-actions">
              <div class="quantity-control">
                <button onclick="updateQuantity(${item.productId}, ${item.tierIndex}, -1)">-</button>
                <span>${item.quantity}</span>
                <button onclick="updateQuantity(${item.productId}, ${item.tierIndex}, 1)">+</button>
              </div>
              <button class="cart-item-remove" onclick="removeFromCart(${item.productId}, ${item.tierIndex})">删除</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="cart-footer">
        <div class="cart-total">
          合计：<span>¥${total}</span>
        </div>
        <a href="/checkout.html" class="btn btn-primary" onclick="closeCartModal()">去结算</a>
      </div>
    `;
  }

  modal.classList.add('active');
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
