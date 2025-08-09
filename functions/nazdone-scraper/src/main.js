import { chromium } from 'playwright-chromium';

export default async function (context) {
  const { req, res, log, error } = context;

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: '/root/.cache/ms-playwright/chromium-1181/chrome-linux/chrome', // مسیر دستی
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    const page = await browser.newPage();

    // آدرس محصول تستی (درخواست می‌تواند از req.body بیاید)
    const productUrl = req.query.url || "https://www.nazdone.com/product/24526/%D8%AA%DB%8C%D8%B4%D8%B1%D8%AA-Little-Bear-NZDE";
    log(`Fetching product: ${productUrl}`);

    await page.goto(productUrl, { waitUntil: 'networkidle' });

    // عنوان
    const title = await page.$eval('h1', el => el.innerText.trim());

    // توضیحات
    const description = await page.$eval('.description', el => el.innerHTML.trim());

    // گالری تصاویر
    const images = await page.$$eval('.product-gallery img', imgs =>
      imgs.map(img => img.src)
    );

    // سایز و رنگ
    const variations = await page.$$eval('.product-variation', nodes => {
      return nodes.map(node => {
        const size = node.querySelector('.size')?.innerText || '';
        const colors = [...node.querySelectorAll('.color')].map(c => ({
          title: c.getAttribute('title'),
          codeColor1: c.style.background || '',
          stockId: c.getAttribute('data-stock-id')
        }));
        return { size, colors };
      });
    });

    // پیدا کردن بزرگترین سایز
    const sizesOrder = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
    const sorted = [...variations].sort((a, b) =>
      sizesOrder.indexOf(b.size) - sizesOrder.indexOf(a.size)
    );
    const biggestSize = sorted[0];
    const price = await page.$eval('.price', el => el.innerText.replace(/[^\d]/g, ''));

    await browser.close();

    return res.json({
      ok: true,
      product: {
        title,
        description,
        images,
        variations,
        biggestSizePrice: parseInt(price) + 200000
      }
    });

  } catch (err) {
    if (browser) await browser.close();
    error(`Scraper error: ${err.message}`);
    return res.json({ ok: false, error: err.message }, 500);
  }
}
