import { chromium } from 'playwright-chromium';
import path from 'path';
import fs from 'fs';

// پیدا کردن مسیر واقعی کرومیوم
function findChromiumExecutable() {
  const basePath = path.resolve('node_modules/.cache/ms-playwright');
  const chromiumFolder = fs.readdirSync(basePath).find(f => f.startsWith('chromium-'));
  if (!chromiumFolder) throw new Error('Chromium folder not found in node_modules cache');
  return path.join(basePath, chromiumFolder, 'chrome-linux', 'chrome');
}

export default async (context) => {
  const { res, log, error } = context;

  try {
    const exePath = findChromiumExecutable();
    log(`Using Chromium executable at: ${exePath}`);

    const browser = await chromium.launch({
      executablePath: exePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    });

    const page = await browser.newPage();
    await page.goto('https://www.nazdone.com/product/24526/%D8%AA%DB%8C%D8%B4%D8%B1%D8%AA-Little-Bear-NZDE', { waitUntil: 'domcontentloaded' });
    const title = await page.title();

    await browser.close();

    return res.json({ ok: true, title });
  } catch (err) {
    error(err);
    return res.json({ ok: false, error: err.message }, 500);
  }
};
