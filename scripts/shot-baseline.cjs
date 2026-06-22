/**
 * 截图脚本：基线（重构前）3 主区 + 同尺寸 after 对比
 * 用系统 Chrome（puppeteer-core connectover 不稳，直接 launch executablePath）
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.env.URL || 'http://localhost:5173/';
const OUT_DIR = process.env.OUT_DIR || './shots';
const STATE = process.env.STATE || 'before'; // before | after

const SIZES = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1280', width: 1280, height: 800 },
];

const AREAS = [
  { id: 'overview', label: '壹总览' },
  { id: 'sync', label: '贰同步' },
  { id: 'settings', label: '叁设置' },
];

async function clickArea(page, areaId) {
  // 顶部 nav button 顺序：壹总览(0) / 贰同步(1) / 叁设置(2)
  const idx = AREAS.findIndex(a => a.id === areaId);
  await page.evaluate((i) => {
    const nav = document.querySelector('header nav');
    if (!nav) return;
    const btns = nav.querySelectorAll('button');
    if (btns[i]) btns[i].click();
  }, idx);
  await new Promise(r => setTimeout(r, 600));
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const os = require('os');
  const tmpBase = path.join(os.tmpdir(), 'chrome-feishu-shot-' + STATE + '-' + Date.now());
  fs.mkdirSync(tmpBase, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-dev-shm-usage',
      '--user-data-dir=' + tmpBase,
    ],
  });
  try {
    for (const size of SIZES) {
      const page = await browser.newPage();
      await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
      await page.goto(URL, { waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
      // Hard disable cache + reload to ensure fresh content
      const client = await page.target().createCDPSession();
      await client.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
      await page.reload({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1200));

      for (const area of AREAS) {
        await clickArea(page, area.id);
        const file = path.join(OUT_DIR, `${STATE}-${area.id}-${size.name}.png`);
        await page.screenshot({ path: file, fullPage: false });
        console.log('saved', file);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
