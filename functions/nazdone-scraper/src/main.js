// ─────────────────────────────────────────────────────────────────────────────
// Force Playwright to prefer local browsers in node_modules and NOT headless_shell
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';
process.env.PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL = '0';
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));

function sizeOrderValue(labelRaw) {
  const label = String(labelRaw || '').trim().toUpperCase();
  const num = parseFloat(label.replace(/[^\d.]/g, ''));
  if (!isNaN(num)) return 1000 + num;
  const map = { XS:1, S:2, M:3, L:4, XL:5, XXL:6, '2XL':6, XXXL:7, '3XL':7, '4XL':8, FREE:2.5, FREESIZE:2.5 };
  if (map[label] !== undefined) return map[label];
  const yearMatch = label.match(/(\d+)\s*سال/);
  if (yearMatch) return 500 + parseInt(yearMatch[1], 10);
  return 0;
}
function pickLargestSize(sizes = []) {
  let chosen = null;
  for (const s of sizes) if (!chosen || sizeOrderValue(s.label) > sizeOrderValue(chosen.label)) chosen = s;
  return chosen;
}
function buildAcfPayloadFromNazdoneSizes(sizes = []) {
  return {
    field_652e80a54a437: (sizes || []).map((sz) => ({
      field_652e834f4a43a: sz.label || '',
      field_652e83674a43b: (sz.colors || []).map((c) => ({
        field_652e83834a43c: c?.title || '',
        field_652e83994a43d: (c?.codeColor1 || '').toString().replace(/^background:\s*/i, ''),
        field_stock_id: c?.stockId || '',
      })),
    })),
  };
}

// ـــ پیدا کردن مسیر اجرایی chrome (نه headless_shell)
function findChromiumExecutable(log) {
  const candidates = [];

  // 1) داخل node_modules (وقتی PLAYWRIGHT_BROWSERS_PATH=0)
  const localRoot = path.resolve('node_modules/playwright-core/.local-browsers');
  if (fs.existsSync(localRoot)) {
    const dirs = fs.readdirSync(localRoot).filter((d) => /^chromium-\d+$/i.test(d));
    dirs.sort((a, b) => parseInt(b.split('-')[1]) - parseInt(a.split('-')[1]));
    for (const d of dirs) {
      candidates.push(path.join(localRoot, d, 'chrome-linux', 'chrome'));
    }
  }

  // 2) مسیر cache سراسری
  const cacheRoot = '/root/.cache/ms-playwright';
  if (fs.existsSync(cacheRoot)) {
    const dirs = fs.readdirSync(cacheRoot).filter((d) => /^chromium-\d+$/i.test(d));
    dirs.sort((a, b) => parseInt(b.split('-')[1]) - parseInt(a.split('-')[1]));
    for (const d of dirs) {
      candidates.push(path.join(cacheRoot, d, 'chrome-linux', 'chrome'));
    }
  }

  for (const p of candidates) if (fs.existsSync(p)) return p;

  // لاگ کمک‌کننده برای عیب‌یابی
  log?.(`No chrome executable found. Checked:\n${candidates.map((p) => ' - ' + p).join('\n') || '  (no candidates)'}`);
  // همچنین لیست فولدرها را چاپ کن
  try {
    if (fs.existsSync(localRoot)) log?.('[browse] local .local-browsers: ' + fs.readdirSync(localRoot).join(', '));
    if (fs.existsSync(cacheRoot)) log?.('[browse] cache ms-playwright: ' + fs.readdirSync(cacheRoot).join(', '));
  } catch {}
  return null;
}

async function scrapeOne(page, productUrl, log) {
  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await WAIT(600);

  const data = await page.evaluate(() => {
    const title =
      (document.querySelector('h1')?.innerText ||
       document.querySelector('.product-title')?.textContent || '').trim();

    const descEl =
      document.querySelector('.product-description') ||
      document.querySelector('#tab-description') ||
      document.querySelector('.woocommerce-Tabs-panel--description');
    const description_html = descEl ? descEl.innerHTML : '';

    const imgs = new Set();
    document.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      if (src && /\.(jpg|jpeg|png|webp)$/i.test(src)) {
        imgs.add(src.replace(/-\d+x\d+(?=\.(jpg|jpeg|png|webp)$)/i, ''));
      }
    });
    const images = Array.from(imgs);

    function digForJson() {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const t = s.textContent || '';
        if (t.includes('sizes') && (t.includes('colors') || t.includes('stockId'))) {
          const m = t.match(/\{[\s\S]*\}/);
          if (m) { try { return JSON.parse(m[0]); } catch(e) {} }
        }
        const assign = t.match(/window\.[A-Za-z0-9_]+\s*=\s*(\{[\s\S]*\});/);
        if (assign) { try { return JSON.parse(assign[1]); } catch(e) {} }
      }
      return null;
    }

    let sizes = [];
    let colors_flat = [];

    const embedded = digForJson();
    if (embedded) {
      const paths = [
        ['product','sizes'], ['sizes'], ['data','sizes'],
        ['variants','sizes'], ['product','variants'], ['variants'],
      ];
      for (const path of paths) {
        let cur = embedded;
        for (const key of path) cur = cur?.[key];
        if (Array.isArray(cur) && cur.length) {
          sizes = cur.map((sz) => {
            const label = sz?.label || sz?.title || sz?.name || '';
            const price = sz?.price ?? sz?.maxPrice ?? sz?.minPrice ?? null;
            const colors = Array.isArray(sz?.colors)
              ? sz.colors.map((c) => ({
                  title: c?.title || c?.name || '',
                  codeColor1: (c?.codeColor1 || c?.color || '').toString().replace(/^background:\s*/i, ''),
                  stockId: c?.stockId || c?.id || '',
                }))
              : [];
            return { label, price, colors };
          });
          break;
        }
      }
      const candidateColors = embedded?.product?.colors || embedded?.colors || embedded?.data?.colors;
      if (Array.isArray(candidateColors)) {
        colors_flat = candidateColors.map((c) => (c?.title || c?.name || '').toString()).filter(Boolean);
      }
    }

    if (!colors_flat.length && sizes.length) {
      const s = new Set();
      sizes.forEach((sz) => (sz.colors || []).forEach((c) => c.title && s.add(c.title)));
      colors_flat = Array.from(s);
    }

    let nazdone_id = null;
    const url = location.href;
    const m = url.match(/\/product\/(\d+)\//);
    if (m) nazdone_id = m[1];

    return { nazdone_id, url, title, description_html, images, sizes, colors_flat };
  });

  if (data.sizes && data.sizes.length) {
    for (const sz of data.sizes) {
      if (sz.price == null) {
        try {
          const priceText = await page.$eval(
            '.price, .product-price, .woocommerce-Price-amount',
            (el) => el.textContent
          );
          const digits = (priceText || '').replace(/[^\d]/g, '');
          if (digits) sz.price = parseInt(digits, 10);
        } catch {}
      }
    }
  }

  const largest = pickLargestSize(data.sizes || []);
  const basePrice = largest?.price ? parseInt(largest.price, 10) : null;
  const finalPrice = basePrice ? basePrice + 200000 : null;

  return {
    ...data,
    _calc: {
      largestSize: largest?.label || null,
      source_last_size_price: basePrice,
      final_applied_price: finalPrice,
    },
    _acf_fields: buildAcfPayloadFromNazdoneSizes(data.sizes || []),
  };
}

export default async (context) => {
  const { req, res, log, error } = context;

  // ورودی
  let body = {};
  try {
    body = req.bodyJson ?? (req.bodyText ? JSON.parse(req.bodyText) : {});
  } catch {
    return res.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }
  const url = body.url || req.query?.url;
  if (!url) return res.json({ ok: false, error: 'Missing "url" in JSON body' }, 400);

  // پیدا کردن chrome
  const executablePath = findChromiumExecutable(log);
  if (!executablePath) {
    return res.json({
      ok: false,
      error: 'Chromium executable not found. Ensure build downloaded browsers into node_modules or /root/.cache.',
    }, 500);
  }
  log(`Using chrome: ${executablePath}`);

  // راه‌اندازی مرورگر
  let browser;
  try {
    browser = await chromium.launch({
      executablePath, // ← اجبار به chrome (نه headless_shell)
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-zygote',
      ],
    });
  } catch (e) {
    error(`Chromium launch failed: ${e.message}`);
    return res.json({ ok: false, error: `Chromium launch failed: ${e.message}` }, 500);
  }

  const page = await browser.newPage();
  try {
    const product = await scrapeOne(page, url, log);
    await browser.close();
    return res.json({
      ok: true,
      products: [{
        nazdone_id: product.nazdone_id,
        url: product.url,
        title: product.title,
        description_html: product.description_html,
        images: product.images,
        colors_flat: product.colors_flat,
        sizes: product.sizes,
        _calc: product._calc,
        _acf_fields: product._acf_fields,
      }],
    }, 200);
  } catch (e) {
    try { await browser.close(); } catch {}
    error(`Scrape failed: ${e.message}`);
    return res.json({ ok: false, error: `Scrape failed: ${e.message}` }, 500);
  }
};
