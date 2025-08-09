// functions/nazdone-scraper/src/main.js
// Appwrite Function (Node 18) — Playwright scraper with context API + pricing calc + ACF payload helper

// مهم: مرورگرها از داخل node_modules استفاده شوند (نه /root/.cache)
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

import { chromium } from 'playwright';

const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));

function sizeOrderValue(labelRaw) {
  const label = String(labelRaw || '').trim().toUpperCase();
  const num = parseFloat(label.replace(/[^\d.]/g, ''));
  if (!isNaN(num)) return 1000 + num; // سایزهای عددی اولویت بالا
  const map = {
    XS: 1, S: 2, M: 3, L: 4, XL: 5, XXL: 6, '2XL': 6,
    XXXL: 7, '3XL': 7, '4XL': 8, FREE: 2.5, FREESIZE: 2.5,
  };
  if (map[label] !== undefined) return map[label];
  const yearMatch = label.match(/(\d+)\s*سال/); // مثلا 5 سال
  if (yearMatch) return 500 + parseInt(yearMatch[1], 10);
  return 0;
}

function pickLargestSize(sizes = []) {
  let chosen = null;
  for (const s of sizes) {
    if (!chosen || sizeOrderValue(s.label) > sizeOrderValue(chosen.label)) chosen = s;
  }
  return chosen;
}

function buildAcfPayloadFromNazdoneSizes(sizes = []) {
  // ساختار ACF (بر اساس کلیدهایی که دادی):
  // Repeater اصلی: field_652e80a54a437
  //   - label سایز: field_652e834f4a43a
  //   - Repeater رنگ‌ها: field_652e83674a43b
  //       - title رنگ: field_652e83834a43c
  //       - code رنگ:  field_652e83994a43d
  //       - stockId:   field_stock_id
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

async function scrapeProduct(page, productUrl, log) {
  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await WAIT(600);

  const data = await page.evaluate(() => {
    const title =
      (document.querySelector('h1')?.innerText ||
        document.querySelector('.product-title')?.textContent ||
        '').trim();

    const descEl =
      document.querySelector('.product-description') ||
      document.querySelector('#tab-description') ||
      document.querySelector('.woocommerce-Tabs-panel--description');
    const description_html = descEl ? descEl.innerHTML : '';

    // گالری تصاویر (به‌صورت یونیک و حذف سایزهای thumbnail)
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
        // دنبال آبجکت‌های شامل sizes/colors/stockId
        if (t.includes('sizes') && (t.includes('colors') || t.includes('stockId'))) {
          const m = t.match(/\{[\s\S]*\}/);
          if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
        }
        const assign = t.match(/window\.[A-Za-z0-9_]+\s*=\s*(\{[\s\S]*\});/);
        if (assign) { try { return JSON.parse(assign[1]); } catch (e) {} }
      }
      return null;
    }

    let sizes = [];
    let colors_flat = [];

    // تلاش برای JSON تعبیه‌شده
    const embedded = digForJson();
    if (embedded) {
      const candidatePaths = [
        ['product', 'sizes'], ['sizes'], ['data', 'sizes'],
        ['variants', 'sizes'], ['product', 'variants'], ['variants'],
      ];
      for (const path of candidatePaths) {
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
      const candidateColors =
        embedded?.product?.colors || embedded?.colors || embedded?.data?.colors;
      if (Array.isArray(candidateColors)) {
        colors_flat = candidateColors.map((c) => (c?.title || c?.name || '').toString()).filter(Boolean);
      }
    }

    // اگر colors_flat از روی sizes قابل استنتاج باشد
    if (!colors_flat.length && sizes.length) {
      const set = new Set();
      sizes.forEach((s) => (s.colors || []).forEach((c) => c.title && set.add(c.title)));
      colors_flat = Array.from(set);
    }

    // استخراج nazdone_id از URL
    let nazdone_id = null;
    const url = location.href;
    const idMatch = url.match(/\/product\/(\d+)\//);
    if (idMatch) nazdone_id = idMatch[1];

    return {
      nazdone_id,
      url,
      title,
      description_html,
      sizes,
      colors_flat,
      images,
    };
  });

  // تلاش دوم برای قیمت در صورت خالی بودن: خواندن قیمت عمومی صفحه
  if (data.sizes && data.sizes.length) {
    for (let i = 0; i < data.sizes.length; i++) {
      if (data.sizes[i].price == null) {
        try {
          const priceText = await page.$eval(
            '.price, .product-price, .woocommerce-Price-amount',
            (el) => el.textContent
          );
          const digits = (priceText || '').replace(/[^\d]/g, '');
          if (digits) data.sizes[i].price = parseInt(digits, 10);
        } catch {
          // ignore
        }
      }
    }
  }

  // محاسبه بزرگترین سایز و قیمت نهایی (افزودن 200,000 تومان)
  const chosen = pickLargestSize(data.sizes || []);
  const base = chosen?.price ? parseInt(chosen.price, 10) : null;
  const finalPrice = base ? base + 200000 : null;

  return {
    ...data,
    _calc: {
      largestSize: chosen?.label || null,
      source_last_size_price: base,
      final_applied_price: finalPrice,
    },
    _acf_fields: buildAcfPayloadFromNazdoneSizes(data.sizes || []),
  };
}

export default async (context) => {
  const { req, res, log, error } = context;

  // خواندن ورودی
  let body = {};
  try {
    body = req.bodyJson ?? (req.bodyText ? JSON.parse(req.bodyText) : {});
  } catch (e) {
    error(`Invalid JSON: ${e.message}`);
    return res.json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const mode = body.mode || 'product';
  const productUrls = Array.isArray(body.productUrls) ? body.productUrls : [];
  const categoryUrl = body.categoryUrl || null;
  const limit = Number(body.limit || 20);

  log(`Start scraper: mode=${mode}, urls=${productUrls.length}, limit=${limit}`);

  // راه‌اندازی مرورگر
  let browser;
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
    });
  } catch (e) {
    error(`Chromium launch failed: ${e.message}`);
    return res.json({ ok: false, error: `Chromium launch failed: ${e.message}` }, 500);
  }

  const page = await browser.newPage();
  const out = [];

  try {
    if (mode === 'category' && categoryUrl) {
      log(`Category: ${categoryUrl}`);
      await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle').catch(() => {});
      await WAIT(600);

      const links = await page.$$eval('a', (as) =>
        Array.from(new Set(as.map((a) => a.href).filter((h) => /\/product\/\d+\//.test(h))))
      );
      const take = links.slice(0, limit);
      log(`Found ${links.length} product links, scraping ${take.length}...`);

      for (const link of take) {
        const p = await scrapeProduct(page, link, log);
        out.push(p);
      }
    } else if (mode === 'product' && productUrls.length) {
      for (const link of productUrls) {
        log(`Product: ${link}`);
        const p = await scrapeProduct(page, link, log);
        out.push(p);
      }
    } else {
      error('Invalid input. Provide {mode:"product", productUrls:[...]} or {mode:"category", categoryUrl:"...", limit:N}');
      try { await browser.close(); } catch {}
      return res.json(
        { ok: false, error: 'Invalid input. Provide {mode:"product", productUrls:[...]} or {mode:"category", categoryUrl:"...", limit:N}' },
        400
      );
    }
  } catch (e) {
    error(`Scrape error: ${e.message}`);
    try { await browser.close(); } catch {}
    return res.json({ ok: false, error: `Scrape failed: ${e.message}` }, 500);
  }

  try { await browser.close(); } catch {}

  log(`Done. products=${out.length}`);
  // ساخت خروجی آماده برای n8n / WooCommerce
  return res.json(
    {
      ok: true,
      products: out.map((p) => ({
        nazdone_id: p.nazdone_id,
        url: p.url,
        title: p.title,
        description_html: p.description_html,
        images: p.images,
        colors_flat: p.colors_flat,
        sizes: p.sizes,
        // فیلدهای محاسباتی برای قیمت
        _calc: p._calc,
        // بدنه‌ی آماده برای ACF
        _acf_fields: p._acf_fields,
      })),
    },
    200
  );
};
