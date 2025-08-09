// functions/nazdone-scraper/src/main.js
// Appwrite Function — Scrape Nazdone product → JSON for n8n/WooCommerce

// مهم: مرورگر را داخل node_modules نصب و استفاده کن (نه /root/.cache)
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

import { chromium } from 'playwright';

const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));

function sizeOrderValue(labelRaw) {
  const label = String(labelRaw || '').trim().toUpperCase();
  const num = parseFloat(label.replace(/[^\d.]/g, ''));
  if (!isNaN(num)) return 1000 + num; // سایزهای عددی
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
  // Repeater اصلی: field_652e80a54a437
  // - label سایز: field_652e834f4a43a
  // - Repeater رنگ‌ها: field_652e83674a43b
  //   - title: field_652e83834a43c
  //   - code : field_652e83994a43d
  //   - stockId: field_stock_id
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

    // تصاویر (منحصر به فرد + حذف ابعاد بندانگشتی)
    const imgs = new Set();
    document.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      if (src && /\.(jpg|jpeg|png|webp)$/i.test(src)) {
        imgs.add(src.replace(/-\d+x\d+(?=\.(jpg|jpeg|png|webp)$)/i, ''));
      }
    });
    const images = Array.from(imgs);

    // تلاش برای یافتن JSON تعبیه‌شده که sizes/colors را دارد
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

    // اگر colors_flat از روی سایزها قابل استنتاج باشد
    if (!colors_flat.length && sizes.length) {
      const s = new Set();
      sizes.forEach((sz) => (sz.colors || []).forEach((c) => c.title && s.add(c.title)));
      colors_flat = Array.from(s);
    }

    // شناسه از URL
    let nazdone_id = null;
    const url = location.href;
    const m = url.match(/\/product\/(\d+)\//);
    if (m) nazdone_id = m[1];

    return { nazdone_id, url, title, description_html, images, sizes, colors_flat };
  });

  // اگر قیمت سایزها خالی بود: تلاش از قیمت عمومی صفحه
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

  // قیمت بر اساس «بزرگ‌ترین سایز»
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

  // 1) ورودی را ایمن بخوان
  let body = {};
  try {
    body = req.bodyJson ?? (req.bodyText ? JSON.parse(req.bodyText) : {});
  } catch (e) {
    return res.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }
  const url = body.url || req.query?.url;
  if (!url) return res.json({ ok: false, error: 'Missing "url" in JSON body' }, 400);

  log(`Nazdone scrape start → ${url}`);

  // 2) راه‌اندازی Playwright
  let browser;
  try {
    browser = await chromium.launch({
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
    return res.json({
      ok: false,
      error: `Chromium launch failed. Make sure build ran: "npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium ffmpeg". ${e.message}`,
    }, 500);
  }

  const page = await browser.newPage();
  const out = [];
  try {
    const product = await scrapeOne(page, url, log);
    out.push(product);
  } catch (e) {
    error(`Scrape error: ${e.message}`);
    try { await browser.close(); } catch {}
    return res.json({ ok: false, error: `Scrape failed: ${e.message}` }, 500);
  }

  try { await browser.close(); } catch {}

  log(`Done. products=${out.length}`);

  // 3) خروجی استاندارد برای n8n / WooCommerce
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
        sizes: p.sizes,            // [{ label, price, colors:[{title, codeColor1, stockId}]}]
        _calc: p._calc,            // { largestSize, source_last_size_price, final_applied_price }
        _acf_fields: p._acf_fields // payload آماده برای ACF در ویرما
      })),
    },
    200
  );
};
