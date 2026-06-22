// Admin JavaScript for Booming Tech Product Management

let currentProduct = null;

// Get product ID from URL
function getProductIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('id');
}

// Load settings for header
async function loadSettings() {
  try {
    const response = await fetch('/api/settings', { credentials: 'include' });
    const settings = await response.json();

    if (settings.companyName) {
      const logoText = document.getElementById('header-logo-text');
      if (logoText) {
        logoText.textContent = ' ' + settings.companyName + ' 管理后台';
      }
      document.title = settings.companyName + ' - 管理后台';
    }

    if (settings.logo) {
      const logoIcon = document.getElementById('header-logo-icon');
      if (logoIcon) {
        logoIcon.outerHTML = '<img src="' + settings.logo + '?t=' + Date.now() + '" alt="Logo" id="header-logo-icon" style="height:40px;width:auto;">';
      }
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

// Load product for editing
async function loadProductForEdit() {
  const productId = getProductIdFromUrl();
  if (!productId) return null;

  try {
    const response = await fetch(`/api/products/${productId}`, { credentials: 'include' });
    if (!response.ok) {
      alert('产品不存在');
      window.location.href = '/admin-product';
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('Error loading product:', error);
    alert('加载产品失败');
    window.location.href = '/admin-product';
    return null;
  }
}

// Populate form with product data
function populateForm(product) {
  document.getElementById('product-id').value = product.id;
  document.getElementById('name').value = product.name;
  document.getElementById('category').value = product.category;
  document.getElementById('price').value = product.price;
  document.getElementById('version').value = product.version || '';
  document.getElementById('platform').value = product.platform || '';
  document.getElementById('icon').value = product.icon || 'software';
  document.getElementById('description').value = product.description || '';
  document.getElementById('featured').checked = product.featured || false;
}

// Update page title
function updatePageTitle(product) {
  const pageTitle = document.getElementById('page-title');
  const breadcrumbTitle = document.getElementById('breadcrumb-title');
  const submitBtn = document.getElementById('submit-btn');

  if (product) {
    pageTitle.textContent = '编辑产品';
    breadcrumbTitle.textContent = '编辑产品';
    submitBtn.textContent = '更新产品';
    document.title = '博铭科技 - 编辑产品';
  } else {
    pageTitle.textContent = '添加产品';
    breadcrumbTitle.textContent = '添加产品';
    submitBtn.textContent = '保存产品';
    document.title = '博铭科技 - 添加产品';
  }
}

// Handle form submit
document.getElementById('product-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('product-id').value;
  const productData = {
    name: document.getElementById('name').value,
    category: document.getElementById('category').value,
    price: parseFloat(document.getElementById('price').value),
    version: document.getElementById('version').value || '1.0.0',
    platform: document.getElementById('platform').value || 'Windows',
    icon: document.getElementById('icon').value,
    description: document.getElementById('description').value || '',
    featured: document.getElementById('featured').checked
  };

  try {
    let response;
    if (id) {
      // Update existing product
      response = await fetch(`/api/products/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(productData),
        credentials: 'include'
      });
    } else {
      // Create new product
      response = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(productData),
        credentials: 'include'
      });
    }

    if (response.ok) {
      alert(id ? '产品更新成功' : '产品添加成功');
      window.location.href = '/admin-product';
    } else {
      const error = await response.json();
      alert('错误: ' + error.error);
    }
  } catch (error) {
    console.error('Error saving product:', error);
    alert('保存产品时出错');
  }
});

// Initialize page
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();

  const productId = getProductIdFromUrl();

  if (productId) {
    // Edit mode - load product
    const product = await loadProductForEdit();
    if (product) {
      populateForm(product);
      updatePageTitle(product);
    }
  } else {
    // Add mode
    updatePageTitle(null);
  }
});
