// functions/nazdone-scraper/src/main.js
// Appwrite Functions (Node 18) — context API + robust logging
import { chromium } from 'playwright';

const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));

function sizeOrderValue(labelRaw) {
  const label = String(labelRaw || '').trim().toUpperCase();
  const num = parseFloat(label.replace(/[^\d.]/g, ''));
  if (!isNaN(num)) return 1000 + num;
  const map = {
    XS: 1, S: 2, M: 3, L: 4, XL: 5, XXL: 6, '2XL': 6,
    XXXL: 7, '3XL': 7, '4XL': 8, FREE: 2.5, FREESIZE: 2.5,
  };
  if (map[label] !== undefined) return map[label];
  const yearMatch = label.match(/(\d+)\s*سال/);
  if (yearMatch) return 500 + parseInt(yearMatch[1], 10);
  return 0;
}

async function scrapeProduct(page, productUrl) {
  await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await WAIT(800);

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

    const imgs = new Set();
    document.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || img.getAttribute('data-src');
      if (src && /\.(jpg|jpeg|png|webp)$/i.test(src)) {
        imgs.add(src.replace(/-\d+x\d+(?=\.(jpg|jpeg|png|webp)$)/i, ''));
      }
    });
    const images = Array.from(imgs);

    function digForJson() {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const t = s.textContent || '';
        // تلاش برای استخراج ساختارهای درون اسکریپت
        if (t.includes('sizes') && (t.includes('colors') || t.includes('stockId'))) {
          const m = t.match(/\{[\s\S]*\}/);
          if (m) {
            try { return JSON.parse(m[0]); } catch (e) {}
          }
        }
        const assign = t.match(/window\.[A-Za-z0-9_]+\s*=\s*(\{[\s\S]*\});/);
        if (assign) {
          try { return JSON.parse(assign[1]); } catch (e) {}
        }
      }
      return null;
    }

    let sizes = [];
    let colors_flat = [];

    // اگر JSON تعبیه‌شده داشته باشد
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
                  codeColor1: (c?.codeColor1 || c?.color || '')
                    .toString()
                    .replace(/^background:\s*/i, ''),
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
        colors_flat = candidateColors
          .map((c) => (c?.title || c?.name || '').toString())
          .filter(Boolean);
      }
    }

    if (!colors_flat.length && sizes.length) {
      const set = new Set();
      sizes.forEach((s) =>
        (s.colors || []).forEach((c) => c.title && set.add(c.title))
      );
      colors_flat = Array.from(set);
    }

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

  // تلاش دوم برای قیمتِ سایزها اگر تهی بود
  if (data.sizes && data.sizes.length) {
    for (let i = 0; i < data.sizes.length; i++) {
      if (data.sizes[i].price == null) {
        try {
          const priceText = await page.$eval(
            '.price, .product-price, .woocommerce-Price-amount',
            (el) => el.textContent
          );
          const digits = priceText.replace(/[^\d]/g, '');
          if (digits) data.sizes[i].price = parseInt(digits, 10);
        } catch {
          // ignore
        }
      }
    }
  }

  return data;
}

export default async (context) => {
  const { req, res, log, error } = context;

  // 1) ورودی را ایمن بخوان
  let payload = {};
  try {
    // Appwrite v1.6+: bodyJson در دسترسه؛ اگر نبود از bodyText استفاده کن
    payload = req.bodyJson ?? (req.bodyText ? JSON.parse(req.bodyText) : {});
  } catch (e) {
    error(`Invalid JSON: ${e.message}`);
    return res.json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const mode = payload.mode || 'product';
  const productUrls = Array.isArray(payload.productUrls) ? payload.productUrls : [];
  const categoryUrl = payload.categoryUrl || null;
  const limit = Number(payload.limit || 20);

  log(`Start function: mode=${mode} urls=${productUrls.length} limit=${limit}`);

  // 2) Playwright را بالا بیار (حالت headless)
  let browser;
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
    });
  } catch (e) {
    error(`Chromium launch failed: ${e.message}`);
    return res.json({ ok: false, error: 'Chromium launch failed' }, 500);
  }

  const page = await browser.newPage();
  const out = [];

  try {
    if (mode === 'category' && categoryUrl) {
      log(`Scrape category: ${categoryUrl}`);
      await page.goto(categoryUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      await WAIT(500);

      const links = await page.$$eval('a', (as) =>
        Array.from(new Set(as.map((a) => a.href).filter((h) => /\/product\/\d+\//.test(h))))
      );
      const take = links.slice(0, limit);
      log(`Found ${links.length} product links, taking ${take.length}`);
      for (const link of take) {
        const p = await scrapeProduct(page, link);
        out.push(p);
      }
    } else if (mode === 'product' && productUrls.length) {
      for (const link of productUrls) {
        log(`Scrape product: ${link}`);
        const p = await scrapeProduct(page, link);
        out.push(p);
      }
    } else {
      error('Invalid input: provide {mode:"product", productUrls:[...]} or {mode:"category", categoryUrl:"..."}');
      await browser.close();
      return res.json(
        {
          ok: false,
          error:
            'Invalid input. Provide {mode:"product", productUrls:[...]} or {mode:"category", categoryUrl:"...", limit:N}',
        },
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
  return res.json({ ok: true, products: out }, 200);
};
