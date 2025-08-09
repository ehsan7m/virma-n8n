process.env.PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL = '0';

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const WAIT = (ms) => new Promise(r => setTimeout(r, ms));

function listDirSafe(dir) {
  try { return fs.existsSync(dir) ? fs.readdirSync(dir) : []; } catch { return []; }
}

// اول از پوشه‌ی غیرنقطه‌ای ما چک می‌کنیم
function findChromeExecutable(log) {
  const roots = [
    path.resolve('node_modules/playwright-browsers'),
    path.resolve('node_modules/.cache/ms-playwright'),
    path.resolve('node_modules/playwright-core/.local-browsers'),
    '/root/.cache/ms-playwright'                                           // fallback
  ];
   const candidates = [];
  for (const root of roots) {
    const dirs = listDirSafe(root)
      .filter(d => /^chromium-\d+/i.test(d))
      .sort((a,b) => parseInt(b.split('-')[1]) - parseInt(a.split('-')[1]));
    for (const d of dirs) {
      candidates.push(path.join(root, d, 'chrome-linux', 'chrome'));
    }
  }
  for (const c of candidates) if (fs.existsSync(c)) return c;

  // لاگ عیب‌یابی
  log?.('Chrome not found. Roots:');
  roots.forEach(r => log?.(` - ${r}: [${listDirSafe(r).join(', ')}]`));
  log?.('Checked:');
  candidates.forEach(c => log?.('  ' + c));
  return null;
}

// --- بقیه‌ی کمکی‌ها (سفارش همان قبلی) ---
function sizeOrderValue(labelRaw) {
  const label = String(labelRaw || '').trim().toUpperCase();
  const num = parseFloat(label.replace(/[^\d.]/g, ''));
  if (!isNaN(num)) return 1000 + num;
  const map = { XS:1, S:2, M:3, L:4, XL:5, XXL:6, '2XL':6, XXXL:7, '3XL':7, '4XL':8, FREE:2.5, FREESIZE:2.5 };
  if (map[label] !== undefined) return map[label];
  const m = label.match(/(\d+)\s*سال/); if (m) return 500 + parseInt(m[1], 10);
  return 0;
}
function pickLargestSize(sizes=[]) {
  return sizes.reduce((acc, s) => (!acc || sizeOrderValue(s.label) > sizeOrderValue(acc.label)) ? s : acc, null);
}
function buildAcfPayloadFromNazdoneSizes(sizes=[]) {
  return {
    field_652e80a54a437: sizes.map(sz => ({
      field_652e834f4a43a: sz.label || '',
      field_652e83674a43b: (sz.colors||[]).map(c => ({
        field_652e83834a43c: c?.title || '',
        field_652e83994a43d: (c?.codeColor1 || '').toString().replace(/^background:\s*/i, ''),
        field_stock_id: c?.stockId || ''
      }))
    }))
  };
}

async function scrapeOne(page, productUrl) {
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
    document.querySelectorAll('img').forEach(img => {
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
          const m = t.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch(e) {} }
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
      for (const p of paths) {
        let cur = embedded; for (const k of p) cur = cur?.[k];
        if (Array.isArray(cur) && cur.length) {
          sizes = cur.map(sz => {
            const label = sz?.label || sz?.title || sz?.name || '';
            const price = sz?.price ?? sz?.maxPrice ?? sz?.minPrice ?? null;
            const colors = Array.isArray(sz?.colors)
              ? sz.colors.map(c => ({
                  title: c?.title || c?.name || '',
                  codeColor1: (c?.codeColor1 || c?.color || '').toString().replace(/^background:\s*/i, ''),
                  stockId: c?.stockId || c?.id || ''
                }))
              : [];
            return { label, price, colors };
          });
          break;
        }
      }
      const cands = embedded?.product?.colors || embedded?.colors || embedded?.data?.colors;
      if (Array.isArray(cands)) {
        colors_flat = cands.map(c => (c?.title || c?.name || '').toString()).filter(Boolean);
      }
    }

    if (!colors_flat.length && sizes.length) {
      const set = new Set();
      sizes.forEach(s => (s.colors||[]).forEach(c => c.title && set.add(c.title)));
      colors_flat = Array.from(set);
    }

    let nazdone_id = null;
    const m = location.href.match(/\/product\/(\d+)\//);
    if (m) nazdone_id = m[1];

    return { nazdone_id, url: location.href, title, description_html, images, sizes, colors_flat };
  });

  if (data.sizes?.length) {
    for (const sz of data.sizes) {
      if (sz.price == null) {
        try {
          const txt = await page.$eval('.price, .product-price, .woocommerce-Price-amount', el => el.textContent);
          const digits = (txt || '').replace(/[^\d]/g, '');
          if (digits) sz.price = parseInt(digits, 10);
        } catch {}
      }
    }
  }

  const largest = pickLargestSize(data.sizes || []);
  const base = largest?.price ? parseInt(largest.price, 10) : null;
  const finalPrice = base ? base + 200000 : null;

  return {
    ...data,
    _calc: {
      largestSize: largest?.label || null,
      source_last_size_price: base,
      final_applied_price: finalPrice
    },
    _acf_fields: buildAcfPayloadFromNazdoneSizes(data.sizes || [])
  };
}

export default async (context) => {
  const { req, res, log, error } = context;

  // ورودی
  let body = {};
  try { body = req.bodyJson ?? (req.bodyText ? JSON.parse(req.bodyText) : {}); }
  catch { return res.json({ ok:false, error:'Invalid JSON body' }, 400); }
  const url = body.url || req.query?.url;
  if (!url) return res.json({ ok:false, error:'Missing "url" in JSON body' }, 400);

  // پیدا کردن chrome از پوشه‌ی غیرنقطه‌ای
  const executablePath = (() => {
    const root = path.resolve('playwright-browsers');
    const dirs = listDirSafe(root).filter(d => /^chromium-\d+/i.test(d))
      .sort((a,b) => parseInt(b.split('-')[1]) - parseInt(a.split('-')[1]));
    for (const d of dirs) {
      const p = path.join(root, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
    log(`playwright-browsers content: [${listDirSafe(root).join(', ')}]`);
    return null;
  })();

  if (!executablePath) {
    return res.json({
      ok:false,
      error:'Chrome executable not found under ./playwright-browsers. Make sure build ran "PLAYWRIGHT_BROWSERS_PATH=playwright-browsers npx playwright install chromium" and that folder is not ignored.'
    }, 500);
  }
  log(`Using chrome: ${executablePath}`);

  // اجرا
  let browser;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--no-first-run','--no-zygote']
    });
  } catch (e) {
    error(`Launch failed: ${e.message}`);
    return res.json({ ok:false, error:`Launch failed: ${e.message}` }, 500);
  }

  try {
    const page = await browser.newPage();
    const p = await scrapeOne(page, url);
    await browser.close();
    return res.json({ ok:true, products:[p] }, 200);
  } catch (e) {
    try { await browser.close(); } catch {}
    error(`Scrape failed: ${e.message}`);
    return res.json({ ok:false, error:`Scrape failed: ${e.message}` }, 500);
  }
};
