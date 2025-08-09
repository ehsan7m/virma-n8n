// functions/nazdone-scraper/src/main.js
import puppeteer from "puppeteer";

const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));

function orderVal(lbl) {
  const s = String(lbl || "").trim().toUpperCase();
  const num = parseFloat(s.replace(/[^\d.]/g, ""));
  if (!isNaN(num)) return 1000 + num;
  const map = { XS:1, S:2, M:3, L:4, XL:5, "2XL":6, XXL:6, "3XL":7, XXXL:7, "4XL":8, FREE:2.5, FREESIZE:2.5 };
  const m = s.match(/(\d+)\s*سال/);
  if (map[s] !== undefined) return map[s];
  if (m) return 500 + parseInt(m[1], 10);
  return 0;
}
const pickLargest = (sizes=[]) => sizes.reduce((a,b)=> (orderVal(b.label)>orderVal(a?.label))?b:a, null);

function buildACF(sizes=[]) {
  return {
    field_652e80a54a437: sizes.map(sz => ({
      field_652e834f4a43a: sz.label || "",
      field_652e83674a43b: (sz.colors||[]).map(c => ({
        field_652e83834a43c: c?.title || "",
        field_652e83994a43d: (c?.codeColor1 || "").replace(/^background:\s*/i, ""),
        field_stock_id: c?.stockId || ""
      }))
    }))
  };
}

async function scrape(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  try { await page.waitForNetworkIdle({ idleTime: 400, timeout: 5000 }); } catch {}
  await WAIT(300);

  const data = await page.evaluate(() => {
    const title = (document.querySelector("h1")?.innerText ||
                   document.querySelector(".product-title")?.textContent || "").trim();

    const descEl = document.querySelector(".product-description")
               || document.querySelector("#tab-description")
               || document.querySelector(".woocommerce-Tabs-panel--description");
    const description_html = descEl ? descEl.innerHTML : "";

    const imgs = new Set();
    document.querySelectorAll("img").forEach(img => {
      const src = img.getAttribute("src") || img.getAttribute("data-src") || "";
      if (src && /\.(jpg|jpeg|png|webp)$/i.test(src))
        imgs.add(src.replace(/-\d+x\d+(?=\.(jpg|jpeg|png|webp)$)/i, ""));
    });
    const images = Array.from(imgs);

    function dig() {
      const scripts = Array.from(document.querySelectorAll("script"));
      for (const s of scripts) {
        const t = s.textContent || "";
        if (t.includes("sizes") && (t.includes("colors") || t.includes("stockId"))) {
          const m = t.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch(e){} }
        }
        const asn = t.match(/window\.[A-Za-z0-9_]+\s*=\s*(\{[\s\S]*\});/);
        if (asn) { try { return JSON.parse(asn[1]); } catch(e){} }
      }
      return null;
    }

    let sizes = [];
    let colors_flat = [];
    const embedded = dig();
    if (embedded) {
      const paths = [
        ["product","sizes"], ["sizes"], ["data","sizes"],
        ["variants","sizes"], ["product","variants"], ["variants"]
      ];
      for (const p of paths) {
        let cur = embedded; for (const k of p) cur = cur?.[k];
        if (Array.isArray(cur) && cur.length) {
          sizes = cur.map(sz => {
            const label = sz?.label || sz?.title || sz?.name || "";
            const price = sz?.price ?? sz?.maxPrice ?? sz?.minPrice ?? null;
            const colors = Array.isArray(sz?.colors)
              ? sz.colors.map(c => ({
                  title: c?.title || c?.name || "",
                  codeColor1: (c?.codeColor1 || c?.color || "").toString(),
                  stockId: c?.stockId || c?.id || ""
                }))
              : [];
            return { label, price, colors };
          });
          break;
        }
      }
      const cs = embedded?.product?.colors || embedded?.colors || embedded?.data?.colors;
      if (Array.isArray(cs)) colors_flat = cs.map(c => (c?.title || c?.name || "")).filter(Boolean);
    }

    if (!colors_flat.length && sizes.length) {
      const st = new Set();
      sizes.forEach(s => (s.colors||[]).forEach(c => c.title && st.add(c.title)));
      colors_flat = Array.from(st);
    }

    let nazdone_id = null;
    const m = location.href.match(/\/product\/(\d+)\//);
    if (m) nazdone_id = m[1];

    return { nazdone_id, url: location.href, title, description_html, images, sizes, colors_flat };
  });

  if (data.sizes?.length) {
    for (const s of data.sizes) {
      if (s.price == null) {
        try {
          const t = await page.$eval(".price, .product-price, .woocommerce-Price-amount", el => el.textContent);
          const d = (t||"").replace(/[^\d]/g, "");
          if (d) s.price = parseInt(d,10);
        } catch {}
      }
    }
  }

  const largest = pickLargest(data.sizes || []);
  const base = largest?.price ? parseInt(largest.price,10) : null;
  const finalPrice = base ? base + 200000 : null;

  return {
    ...data,
    _calc: {
      largestSize: largest?.label || null,
      source_last_size_price: base,
      final_applied_price: finalPrice
    },
    _acf_fields: buildACF(data.sizes || [])
  };
}

export default async (context) => {
  const { req, res, error } = context;

  // ورودی
  let body = {};
  try { body = req.bodyJson ?? (req.bodyText ? JSON.parse(req.bodyText) : {}); }
  catch { return res.json({ ok:false, error:"Invalid JSON body" }, 400); }
  const url = body.url || req.query?.url;
  if (!url) return res.json({ ok:false, error:'Missing "url" in JSON body' }, 400);

  // اجرای Puppeteer با باینری دانلود شده در Build
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: puppeteer.executablePath(), // ← همون باینریِ دانلودشده
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--no-first-run","--no-zygote"]
    });
  } catch (e) {
    error(`Chromium launch failed: ${e.message}`);
    return res.json({ ok:false, error:`Chromium launch failed: ${e.message}` }, 500);
  }

  try {
    const page = await browser.newPage();
    const product = await scrape(page, url);
    await browser.close();
    return res.json({ ok:true, products:[product] }, 200);
  } catch (e) {
    try { await browser.close(); } catch {}
    error(`Scrape failed: ${e.message}`);
    return res.json({ ok:false, error:`Scrape failed: ${e.message}` }, 500);
  }
};
