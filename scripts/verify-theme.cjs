/**
 * verify-theme.cjs - 验证 @theme 修复后品牌色/字体 utilities 真生效
 *
 * 启动 vite dev → puppeteer-core + 系统 Chrome headless → 抓取关键元素 computed style
 *
 * 抽样维度（对照 04 §6.1 hex + §6.2 字体）：
 *   1. 印章 logo 背景色 = #9e2b25 (seal)
 *   2. 正文文字色 = #2b2b2b (ink)
 *   3. 分隔线/边框色 = #cabfa6 (line)
 *   4. 标题字体 = KaiTi 楷体 (font-kai)
 *   5. 徽章/按钮字体 = sans-serif (font-sans)
 *   6. 路径/时间戳字体 = monospace (font-mono)
 *   7. 卡片背景色 = #fffdf7 (card-bg)
 *   8. body 主区背景 = #f5f1e6 (paper)
 *   9. 副文字色 = #4f4b44 (ink-soft)
 *  10. 朱红强调色 = #9e2b25 (seal as text)
 */
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://127.0.0.1:5174';
const SCREENSHOTS_DIR = path.resolve(__dirname, '../../projects-memory/projects/feishu-sync/agent-outputs/luoshen/20260619-theme-fix/screenshots');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForVite(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(APP_URL);
      if (res.ok) return true;
    } catch (e) {
      // not ready yet
    }
    await sleep(500);
  }
  return false;
}

async function grabSample(page, label, selector, properties) {
  // selector is a CSS selector; properties is array of computed style property names
  const result = await page.evaluate((sel, props) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false, selector: sel };
    const cs = window.getComputedStyle(el);
    const out = { found: true, selector: sel, tagName: el.tagName, className: el.className };
    for (const p of props) out[p] = cs.getPropertyValue(p);
    return out;
  }, selector, properties);
  return { label, ...result };
}

(async () => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // 1. Start vite dev
  console.log('[1/5] Starting vite dev server...');
  const vite = spawn('npm', ['run', 'dev', '--', '--port', '5174', '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.resolve(__dirname, '..'),
    shell: true,
    stdio: 'pipe',
  });
  let viteOut = '';
  vite.stdout.on('data', d => { viteOut += d.toString(); });
  vite.stderr.on('data', d => { viteOut += d.toString(); });

  try {
    console.log('[2/5] Waiting for vite to be ready...');
    const ready = await waitForVite(30000);
    if (!ready) {
      console.error('FAIL: vite did not become ready in 30s');
      console.error('vite output:', viteOut);
      process.exit(2);
    }
    console.log('  vite ready at', APP_URL);

    // 3. Launch Chrome
    console.log('[3/5] Launching Chrome headless...');
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1440,900',
        // Fix localhost resolution on Windows headless
        '--host-resolver-rules=MAP localhost 127.0.0.1',
        `--user-data-dir=${path.resolve(__dirname, '../.chrome-verify-profile')}`,
      ],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

      console.log('[4/5] Loading app and capturing samples...');
      // Retry page.goto - sometimes Chrome needs a moment to be ready after launch
      let loaded = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await page.goto(APP_URL, { waitUntil: 'networkidle0', timeout: 15000 });
          loaded = true;
          break;
        } catch (e) {
          console.log(`  goto attempt ${attempt + 1} failed: ${e.message.slice(0, 80)}`);
          await sleep(1500);
        }
      }
      if (!loaded) throw new Error('page.goto failed after 5 attempts');
      // Wait for app to render (give React time)
      await sleep(1500);

      // Determine which view rendered first. If auth gating blocks, just sample what's visible.
      // Strategy: sample elements that exist; mark missing ones as not-found.

      const samples = [];

      // Sample 1: TopBar logo (印章). className contains 'seal-stamp' or bg-seal in TopBar
      samples.push(await grabSample(page, 'logo (印章) bg-seal', '[class*="seal-stamp"], [class*="bg-seal"]', ['background-color', 'color', 'width', 'height']));

      // Sample 2: body / main wrapper (paper background)
      samples.push(await grabSample(page, 'body', 'body', ['background-color', 'color', 'font-family']));

      // Sample 3: h1 / h2 / h3 (default kai per base layer)
      samples.push(await grabSample(page, 'h1 (default kai)', 'h1', ['font-family', 'color']));
      samples.push(await grabSample(page, 'h2 (default kai)', 'h2', ['font-family', 'color']));

      // Sample 4: TopBar h1 with font-kai explicitly (Chinese number 序号)
      samples.push(await grabSample(page, 'TopBar nav 壹 (font-kai)', '[class*="font-kai"]', ['font-family', 'color']));

      // Sample 5: text-ink (most common text color utility)
      samples.push(await grabSample(page, 'text-ink', '[class*="text-ink"]:not([class*="text-ink-"])', ['color', 'font-family']));

      // Sample 6: text-ink-soft (description text)
      samples.push(await grabSample(page, 'text-ink-soft', '[class*="text-ink-soft"]', ['color']));

      // Sample 7: text-ink-faint (timestamp text)
      samples.push(await grabSample(page, 'text-ink-faint', '[class*="text-ink-faint"]', ['color']));

      // Sample 8: text-seal (red accent)
      samples.push(await grabSample(page, 'text-seal', '[class*="text-seal"]:not([class*="text-seal-"])', ['color']));

      // Sample 9: text-jade (green accent)
      samples.push(await grabSample(page, 'text-jade', '[class*="text-jade"]:not([class*="text-jade-soft"])', ['color']));

      // Sample 10: border-line (most common border)
      samples.push(await grabSample(page, 'border-line', '[class*="border-line"]', ['border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color']));

      // Sample 11: bg-card-bg / bg-paper
      samples.push(await grabSample(page, 'bg-card-bg', '[class*="bg-card-bg"]', ['background-color']));
      samples.push(await grabSample(page, 'bg-paper (not -2)', '[class*="bg-paper"]:not([class*="bg-paper-2"])', ['background-color']));
      samples.push(await grabSample(page, 'bg-paper-2', '[class*="bg-paper-2"]', ['background-color']));

      // Sample 12: font-mono (path / timestamp)
      samples.push(await grabSample(page, 'font-mono', '[class*="font-mono"]', ['font-family']));

      // Sample 13: font-sans (badge / button)
      samples.push(await grabSample(page, 'font-sans', '[class*="font-sans"]:not([class*="font-sans-ui"])', ['font-family']));

      // Sample 14: font-serif (body text)
      samples.push(await grabSample(page, 'font-serif', '[class*="font-serif"]', ['font-family']));

      // 5. Screenshot for visual evidence
      console.log('[5/5] Taking screenshots...');
      // Default view
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'theme-fix-default-1440.png'), fullPage: false });

      // Try switching to each main area
      const views = ['壹总览', '贰同步', '叁设置'];
      for (const v of views) {
        try {
          const clicked = await page.evaluate((label) => {
            const btns = Array.from(document.querySelectorAll('button, [role="tab"], nav *'));
            const t = btns.find(b => b.textContent && b.textContent.includes(label));
            if (t) { t.click(); return true; }
            return false;
          }, v);
          if (clicked) {
            await sleep(1000);
            const fname = `theme-fix-${v}-1440.png`;
            await page.screenshot({ path: path.join(SCREENSHOTS_DIR, fname), fullPage: false });
            console.log(`  captured ${fname}`);

            // After entering this view, re-sample to fill gaps
            const moreSamples = [];
            moreSamples.push(await grabSample(page, `[${v}] font-sans`, '[class*="font-sans"]:not([class*="font-sans-ui"])', ['font-family', 'color']));
            moreSamples.push(await grabSample(page, `[${v}] font-serif`, '[class*="font-serif"]', ['font-family']));
            moreSamples.push(await grabSample(page, `[${v}] bg-paper-2`, '[class*="bg-paper-2"]', ['background-color']));
            moreSamples.push(await grabSample(page, `[${v}] text-jade`, '[class*="text-jade"]:not([class*="text-jade-soft"])', ['color']));
            moreSamples.push(await grabSample(page, `[${v}] bg-seal-2`, '[class*="bg-seal-2"]', ['background-color']));
            moreSamples.push(await grabSample(page, `[${v}] bg-jade`, '[class*="bg-jade"]:not([class*="bg-jade-soft"])', ['background-color']));
            moreSamples.push(await grabSample(page, `[${v}] text-seal-2`, '[class*="text-seal-2"]', ['color']));
            moreSamples.push(await grabSample(page, `[${v}] border-seal`, '[class*="border-seal"]:not([class*="border-seal-2"])', ['border-top-color']));
            for (const s of moreSamples) {
              if (s.found) samples.push(s);
            }
          } else {
            console.log(`  (skip ${v}: button not found)`);
          }
        } catch (e) {
          console.log(`  (skip ${v}: ${e.message})`);
        }
      }

      // Dump samples as JSON for parsing
      console.log('\n=== SAMPLES_START ===');
      console.log(JSON.stringify(samples, null, 2));
      console.log('=== SAMPLES_END ===');
    } finally {
      await browser.close();
    }
  } finally {
    // Kill vite
    try { vite.kill('SIGTERM'); } catch (e) {}
    // Give it a moment to release the port
    await sleep(500);
    try { vite.kill('SIGKILL'); } catch (e) {}
  }
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
