import puppeteer from 'puppeteer';

export default async function (context) {
  const { req, res, log, error } = context;

  try {
    log("Launching Chromium from custom cache path...");

    const executablePath = '/usr/local/server/puppeteer-cache/chrome/linux-127.0.6533.88/chrome'; 
    // ⚠ مسیر دقیق پوشه رو بعد از اولین دانلود توی لاگ‌ها پیدا کن و اینجا جایگزین کن.

    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    const productUrl = req.query.url || "https://www.nazdone.com/product/24526/%D8%AA%DB%8C%D8%B4%D8%B1%D8%AA-Little-Bear-NZDE";
    
    log(`Navigating to: ${productUrl}`);
    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // نمونه استخراج عنوان و قیمت
    const data = await page.evaluate(() => {
      const title = document.querySelector('h1.product-title')?.innerText || null;
      const price = document.querySelector('.product-price')?.innerText || null;
      return { title, price };
    });

    await browser.close();
    log("Scraping completed successfully.");

    return res.json({ ok: true, data });

  } catch (err) {
    error(`Scraping failed: ${err.message}`);
    return res.json({ ok: false, error: err.message }, 500);
  }
}
