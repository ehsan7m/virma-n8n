import { chromium } from "playwright";

export default async ({ req, res, log, error }) => {
  // گرفتن URL محصول از payload یا query
  const productUrl =
    req.body?.url ||
    req.query?.url ||
    "https://www.nazdone.com/product/24526/%D8%AA%DB%8C%D8%B4%D8%B1%D8%AA-Little-Bear-NZDE";

  log(`Scraping product from: ${productUrl}`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage();
    await page.goto(productUrl, { waitUntil: "domcontentloaded" });

    // نمونه استخراج داده محصول (قابل توسعه بعداً)
    const data = await page.evaluate(() => {
      const title = document.querySelector("h1")?.innerText.trim() || null;
      const price = document
        .querySelector(".price")
        ?.innerText.replace(/[^\d]/g, "") || null;
      const images = Array.from(
        document.querySelectorAll(".product-gallery img")
      ).map((img) => img.src);

      return { title, price, images };
    });

    await browser.close();

    return res.json({
      success: true,
      source: productUrl,
      scraped: data,
    });
  } catch (err) {
    if (browser) await browser.close();
    error(`Scraping failed: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};
