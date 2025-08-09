import { chromium } from 'playwright';

const executablePath = '/root/.cache/ms-playwright/chromium-1181/chrome-linux/chrome';

export default async (context) => {
  const { req, res, log, error } = context;

  try {
    const browser = await chromium.launch({
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    });

    const page = await browser.newPage();
    await page.goto('https://www.nazdone.com/product/24526/%D8%AA%DB%8C%D8%B4%D8%B1%D8%AA-Little-Bear-NZDE', { waitUntil: 'domcontentloaded' });

    const title = await page.title();

    await browser.close();

    return res.json({ ok: true, title });
  } catch (e) {
    error(e);
    return res.json({ ok: false, error: e.message }, 500);
  }
};
