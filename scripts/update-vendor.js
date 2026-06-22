#!/usr/bin/env node
// 从 vendor-manifest.json 读取 CDN URLs，下载到 public/vendor/，验证 sha256
// 手动跑：npm run update-vendor
// 自动跑：postinstall 钩子
//
// 跳过：如果环境变量 SKIP_VENDOR_UPDATE=1 则直接退出
// 失败：任一文件下载失败或 sha256 不匹配则 exit 1

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'public', 'vendor', 'vendor-manifest.json');
const VENDOR_DIR = path.join(ROOT, 'public', 'vendor');

if (process.env.SKIP_VENDOR_UPDATE === '1') {
  console.log('[update-vendor] SKIP_VENDOR_UPDATE=1, skipping');
  process.exit(0);
}

if (!fs.existsSync(MANIFEST)) {
  console.error('[update-vendor] manifest not found:', MANIFEST);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const files = manifest.files || [];

if (files.length === 0) {
  console.log('[update-vendor] no files in manifest');
  process.exit(0);
}

function download(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

(async () => {
  let changed = 0, skipped = 0, failed = 0;
  for (const f of files) {
    const target = path.join(ROOT, 'public', f.vendor_path);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const existing = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (existing) {
      const existingHash = sha256(existing);
      if (existingHash === f.sha256) {
        console.log(`[update-vendor] OK  ${f.name} (sha256 matches, skip)`);
        skipped++;
        continue;
      }
    }

    try {
      console.log(`[update-vendor] GET ${f.cdn_url}`);
      const buf = await download(f.cdn_url);
      const hash = sha256(buf);
      if (hash !== f.sha256) {
        console.error(`[update-vendor] FAIL ${f.name} sha256 mismatch`);
        console.error(`  expected: ${f.sha256}`);
        console.error(`  got:      ${hash}`);
        failed++;
        continue;
      }
      fs.writeFileSync(target, buf);
      console.log(`[update-vendor] OK  ${f.name} -> ${f.vendor_path} (${buf.length} bytes)`);
      changed++;
    } catch (e) {
      console.error(`[update-vendor] FAIL ${f.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`[update-vendor] done: ${changed} changed, ${skipped} skipped, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
