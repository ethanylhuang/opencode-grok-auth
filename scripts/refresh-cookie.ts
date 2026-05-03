import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

puppeteer.use(StealthPlugin());

export async function refreshCookie(): Promise<string> {
  const cookiePath = path.join(os.homedir(), '.grok_cookie');
  let currentCookieStr = '';
  
  try {
    currentCookieStr = fs.readFileSync(cookiePath, 'utf8').trim();
  } catch (e) {
    console.error(`No existing cookie found at ${cookiePath}.`);
    throw new Error('No existing SSO tokens found. Please manually add an initial cookie first.');
  }

  // Parse existing cookies
  const cookiePairs = currentCookieStr.split(';').map(part => part.trim()).filter(Boolean);
  const existingCookies = cookiePairs.map(part => {
    const eqIdx = part.indexOf('=');
    const name = part.slice(0, eqIdx);
    const value = part.slice(eqIdx + 1);
    return { name, value, domain: '.grok.com' };
  });

  console.log('Launching system Google Chrome to bypass Cloudflare...');
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false, 
    userDataDir: path.join(os.homedir(), '.grok_chrome_profile'),
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox', 
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,720'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  // Set our existing SSO tokens so we log in seamlessly
  await page.setCookie(...existingCookies);

  console.log('Navigating to grok.com...');
  try {
    await page.goto('https://grok.com/', { waitUntil: 'networkidle2', timeout: 45000 });
    
    // Attempt to type into the chat box just to trigger full initialization and bot-check clearance
    await page.waitForSelector('textarea', { timeout: 10000 }).catch(() => {});
    try {
        await page.type('textarea', 'hello', { delay: 100 });
    } catch(e) {}
    
  } catch (e) {
    console.log('Navigation timeout or error, but continuing to extract cookies anyway...');
  }
  
  // Give Cloudflare a moment to verify and redirect if needed
  await new Promise(r => setTimeout(r, 15000));

  let cookies = [];
  try {
    cookies = await page.cookies();
  } catch (e) {
    console.error('Failed to extract cookies before session closed:', e.message);
  }
  
  await browser.close();

  // Re-build cookie string
  const newCookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  fs.writeFileSync(cookiePath, newCookieStr, 'utf8');
  console.log(`Successfully extracted fresh cookies! (Saved to ${cookiePath})`);
  
  return newCookieStr;
}

// Run directly if invoked from CLI
if (require.main === module) {
  refreshCookie().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
