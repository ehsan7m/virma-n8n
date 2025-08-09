import { chromium } from "playwright";

export default async ({ req, res, log, error }) => {
  const url = req.body?.url || req.query?.url;
  if (!url) {
    return res.json({ success: false, error: "Product URL is required" }, 400);
  }

  let browser;
  try {
    // استفاده از مسیر باینری لوکال تا مشکل headless_shell حل شود
    const executablePath = require("playwright").chromium.executablePath();

    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // نمونه اسکرپ از محصول نازدونه
    const product = await page.evaluate(() => {
      const title = document.querySelector("h1")?.innerText.trim() || "";
      const priceEl = document.querySelector(".product-price bdi")?.innerText || "";
      const gallery = [...document.querySelectorAll(".woocommerce-product-gallery__image img")]
        .map(img => img.src);

      return { title, price: priceEl, images: gallery };
    });

    await browser.close();

    // بازگشت نتیجه برای n8n
    return res.json({ success: true, product });
  } catch (err) {
    if (browser) await browser.close();
    error(`Scraping failed: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};
