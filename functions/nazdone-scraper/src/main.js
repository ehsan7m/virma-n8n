import { chromium } from 'playwright';

export default async function (req, res) {
  try {
    const { productUrl } = req.body;

    if (!productUrl) {
      res.status(400).json({ error: 'productUrl is required in request body' });
      return;
    }

    // اجرای کرومیوم از مسیر cache global در Appwrite
    const browser = await chromium.launch({
      headless: true,
      executablePath: '/root/.cache/ms-playwright/chromium-1181/chrome-linux/chrome', // نسخه را از لاگ نصب ببین
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.goto(productUrl, { waitUntil: 'networkidle' });

    // استخراج داده‌ها
    const data = await page.evaluate(() => {
      const title = document.querySelector('h1')?.innerText || '';
      const description = document.querySelector('.product-description')?.innerHTML || '';

      // قیمت بزرگ‌ترین سایز
      let lastPrice = '';
      const priceElements = Array.from(document.querySelectorAll('.price-amount'));
      if (priceElements.length > 0) {
        lastPrice = priceElements[priceElements.length - 1].innerText.replace(/[^\d]/g, '');
      }

      // گالری تصاویر
      const images = Array.from(document.querySelectorAll('.woocommerce-product-gallery__image img'))
        .map(img => img.src);

      // سایز و رنگ (ساختار Nazdone)
      const sizes = [];
      const sizeElements = document.querySelectorAll('.sizes .size');
      sizeElements.forEach(sizeEl => {
        const sizeTitle = sizeEl.innerText.trim();
        const colors = [];
        const colorEls = sizeEl.querySelectorAll('.colors .color');
        colorEls.forEach(colorEl => {
          colors.push({
            title: colorEl.getAttribute('title'),
            codeColor1: colorEl.style.background,
            stockId: colorEl.getAttribute('data-stock-id') || ''
          });
        });
        sizes.push({ size: sizeTitle, colors });
      });

      return {
        title,
        description,
        lastPrice,
        images,
        sizes
      };
    });

    await browser.close();

    // خروجی برای N8N
    res.json({
      success: true,
      source: productUrl,
      ...data
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: err.message });
  }
}
