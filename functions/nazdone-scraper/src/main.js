// استفاده از مرورگر نصب‌شده داخل node_modules
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

import { chromium } from 'playwright';

/**
 * این فانکشن نمونه، محصول رو از URL می‌گیره و عنوانش رو برمی‌گردونه
 * @param {import('@appwrite/functions').Context} context 
 */
export default async (context) => {
  const { req, res, log, error } = context;

  try {
    // دریافت ورودی از body
    let body = {};
    try {
      body = req.bodyJson ?? JSON.parse(req.bodyText ?? "{}");
    } catch (e) {
      error(`Bad JSON: ${e.message}`);
      return res.json({ ok: false, error: "Invalid JSON" }, 400);
    }

    if (!body.productUrls || !Array.isArray(body.productUrls) || !body.productUrls.length) {
      return res.json({ ok: false, error: "No productUrls provided" }, 400);
    }

    log(`Starting scrape for ${body.productUrls.length} products...`);

    // راه‌اندازی مرورگر
    const browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
    });

    const results = [];

    for (const url of body.productUrls) {
      try {
        const page = await browser.newPage();
        log(`Navigating to ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // نمونه داده: گرفتن عنوان صفحه
        const title = await page.title();

        results.push({ url, title });
        await page.close();
      } catch (scrapeErr) {
        error(`Error scraping ${url}: ${scrapeErr.message}`);
        results.push({ url, error: scrapeErr.message });
      }
    }

    await browser.close();

    log("Scraping finished.");
    return res.json({ ok: true, products: results }, 200);

  } catch (err) {
    error(`Unexpected error: ${err.message}`);
    return res.json({ ok: false, error: err.message }, 500);
  }
};
