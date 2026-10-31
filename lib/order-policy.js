'use strict';

/**
 * 下单项校验 —— 唯一事实来源（single source of truth）。
 *
 * 为什么单独抽一个模块：
 *   - server.js 的 POST /api/orders 要用它；
 *   - 草稿/上架闸门（下单时拒绝未上架产品）要在这里；
 *   - 其它调用方（如 MCP 产品工具）也需要同一套判定，不允许各写一份。
 *
 * 以前验证脚本里内联了一份 server.js 的副本。B-2 那轮已经踩过
 * 「内联副本和被测代码静默漂移」的坑：副本漏掉了草稿闸门，测试全绿，
 * 而线上仍能下单草稿产品。现在只有这一份实现，改哪都改这里。
 *
 * 安全要点：
 *   1. 完全忽略客户端送的 price / totalAmount —— 只用 loadProduct 拉到的权威价。
 *   2. productId 必须能在 DB 查到。
 *   3. 产品必须是已上架状态（草稿 / 已下架不可下单）。
 *   4. tierIndex 必须是 -1（基础方案）或落在 pricingTiers 数组范围内。
 *   5. quantity 必须是 [1, 99] 范围内的整数。
 *   6. 返回的 normalized 字段全部为服务端正本，写库用此值。
 *
 * 错误码（每条都映射一个稳定字符串，方便后续日志聚合与前台文案映射）：
 *   INVALID_ITEM / INVALID_PRODUCT_ID / INVALID_QUANTITY /
 *   INVALID_TIER_INDEX / PRODUCT_NOT_FOUND / PRODUCT_NOT_AVAILABLE /
 *   TIER_NOT_AVAILABLE / TIER_OUT_OF_RANGE / PRICE_NOT_AVAILABLE
 */

/** 稳定的错误码表。冻结，防止调用方意外改写。 */
const ORDER_ITEM_ERROR_CODES = Object.freeze({
  INVALID_ITEM: 'INVALID_ITEM',
  INVALID_PRODUCT_ID: 'INVALID_PRODUCT_ID',
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  INVALID_TIER_INDEX: 'INVALID_TIER_INDEX',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  PRODUCT_NOT_AVAILABLE: 'PRODUCT_NOT_AVAILABLE',
  TIER_NOT_AVAILABLE: 'TIER_NOT_AVAILABLE',
  TIER_OUT_OF_RANGE: 'TIER_OUT_OF_RANGE',
  PRICE_NOT_AVAILABLE: 'PRICE_NOT_AVAILABLE'
});

/** 基础方案（tierIndex = -1）的授权时长：一年。 */
const DEFAULT_DURATION_DAYS = 365;

/** 单条订单项的最大购买数量。 */
const MAX_ITEM_QUANTITY = 99;

/**
 * 产品是否可下单。
 *
 * products.status 是草稿/上架开关：1 = 已上架，0 = 草稿（前台不可见）。
 * db.js 的 mapProductStatus 已把这一列映射成 'published' / 'draft' 字符串，
 * 所以这里只认 'published' —— 其余取值（草稿、未知、字段缺失）一律拒绝。
 */
function isProductOrderable(product) {
  return !!product && product.status === 'published';
}

/**
 * 只校验下单项本身的形状，不查库。
 *
 * @param {object} rawItem 客户端送来的下单项
 * @returns {{error?: string, productId?: number, quantity?: number, tierIndex?: number}}
 */
function validateOrderItemShape(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') {
    return { error: ORDER_ITEM_ERROR_CODES.INVALID_ITEM };
  }

  const productId = Number(rawItem.productId);
  if (!Number.isInteger(productId) || productId <= 0) {
    return { error: ORDER_ITEM_ERROR_CODES.INVALID_PRODUCT_ID };
  }

  const rawQuantity = Number(rawItem.quantity);
  if (!Number.isInteger(rawQuantity) || rawQuantity < 1 || rawQuantity > MAX_ITEM_QUANTITY) {
    return { error: ORDER_ITEM_ERROR_CODES.INVALID_QUANTITY };
  }

  // tierIndex 必须客户端送真正的 number：-1（基础方案）或 0..n-1。
  // 不做 Number() 宽松转换——否则 "" / null / "abc" 会被压成 0（= 第一档），或被静默接受。
  if (typeof rawItem.tierIndex !== 'number') {
    return { error: ORDER_ITEM_ERROR_CODES.INVALID_TIER_INDEX };
  }
  const rawTierIndex = rawItem.tierIndex;
  if (!Number.isInteger(rawTierIndex) || (rawTierIndex !== -1 && rawTierIndex < 0)) {
    return { error: ORDER_ITEM_ERROR_CODES.INVALID_TIER_INDEX };
  }

  return { productId, quantity: rawQuantity, tierIndex: rawTierIndex };
}

/**
 * 用权威产品数据给下单项定价。
 *
 * @param {{productId: number, quantity: number, tierIndex: number}} item
 * @param {object} product db.getProduct 拉到的产品
 * @returns {{error?: string, normalized?: object}}
 */
function resolveOrderItemPricing(item, product) {
  const pricingTiers = Array.isArray(product.pricingTiers) ? product.pricingTiers : null;

  let unitPrice;
  let durationDays;

  if (item.tierIndex === -1) {
    // 基础方案：用 product.price
    const basePrice = Number(product.price);
    if (!Number.isFinite(basePrice) || basePrice < 0) {
      return { error: ORDER_ITEM_ERROR_CODES.PRICE_NOT_AVAILABLE };
    }
    unitPrice = basePrice;
    durationDays = DEFAULT_DURATION_DAYS;
  } else {
    // 多方案：tierIndex 必须严格落在 pricingTiers 范围内
    if (!pricingTiers || pricingTiers.length === 0) {
      return { error: ORDER_ITEM_ERROR_CODES.TIER_NOT_AVAILABLE };
    }
    if (item.tierIndex >= pricingTiers.length) {
      return { error: ORDER_ITEM_ERROR_CODES.TIER_OUT_OF_RANGE };
    }
    const tier = pricingTiers[item.tierIndex];
    if (!tier || typeof tier !== 'object') {
      return { error: ORDER_ITEM_ERROR_CODES.TIER_OUT_OF_RANGE };
    }
    const tierPrice = Number(tier.price);
    if (!Number.isFinite(tierPrice) || tierPrice < 0) {
      return { error: ORDER_ITEM_ERROR_CODES.PRICE_NOT_AVAILABLE };
    }
    unitPrice = tierPrice;
    // durationDays 是历史字段名；当前价格方案的时长字段是 duration（月）。
    // 读不到就按一年算，保持既有行为不变。
    const tierDays = Number(tier.durationDays);
    durationDays = Number.isInteger(tierDays) && tierDays > 0 ? tierDays : DEFAULT_DURATION_DAYS;
  }

  return {
    normalized: {
      productId: product.id,
      productName: product.name || '',
      productShortName: product.shortName || '',
      price: unitPrice,
      quantity: item.quantity,
      durationDays
    }
  };
}

/**
 * 校验 + 重算单条订单项的价格。
 *
 * @param {object} rawItem 客户端送来的下单项
 * @param {(productId: number) => Promise<object|null>} loadProduct 取权威产品的函数
 *        （server.js 传 `(id) => db.getProduct(id)`）
 * @returns {Promise<{error?: string, normalized?: object}>}
 */
async function resolveAndValidateOrderItem(rawItem, loadProduct) {
  if (typeof loadProduct !== 'function') {
    throw new TypeError('resolveAndValidateOrderItem 需要 loadProduct 函数');
  }

  const shape = validateOrderItemShape(rawItem);
  if (shape.error) {
    return shape;
  }

  const product = await loadProduct(shape.productId);
  if (!product) {
    return { error: ORDER_ITEM_ERROR_CODES.PRODUCT_NOT_FOUND };
  }

  // 草稿 / 已下架的产品不可下单。
  // 前台接口已过滤，但下单接口直接按 id 取产品 —— 不加这道闸，草稿产品就能被下单。
  if (!isProductOrderable(product)) {
    return { error: ORDER_ITEM_ERROR_CODES.PRODUCT_NOT_AVAILABLE };
  }

  return resolveOrderItemPricing(shape, product);
}

module.exports = {
  ORDER_ITEM_ERROR_CODES,
  DEFAULT_DURATION_DAYS,
  MAX_ITEM_QUANTITY,
  isProductOrderable,
  validateOrderItemShape,
  resolveOrderItemPricing,
  resolveAndValidateOrderItem
};
