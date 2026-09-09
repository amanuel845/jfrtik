const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// Helper to render page and get full HTML after JS execution
async function fetchRenderedHtml(url) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  // Wait a bit for any delayed content
  await page.waitForTimeout(2000);
  const html = await page.content();
  await browser.close();
  return html;
}

// Extract data from rendered HTML
function extractFromHtml(html) {
  const data = {
    title: null,
    description: null,
    cover: null,
    author: {
      nickname: null,
      uniqueId: null,
      avatar: null,
    },
    stats: {},
    videoUrl: null,
    canonicalUrl: null,
    rawJson: null,
  };

  // 1. Try to find Next.js data
  const nextDataRegex = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
  const nextMatch = html.match(nextDataRegex);
  if (nextMatch) {
    try {
      const json = JSON.parse(nextMatch[1]);
      data.rawJson = json;
      const pageProps = json?.props?.pageProps;
      if (pageProps) {
        const videoData = pageProps.videoData || pageProps.data || pageProps;
        if (videoData) {
          data.title = videoData.title || videoData.desc || null;
          data.description = videoData.description || videoData.desc || null;
          data.cover = videoData.cover || videoData.thumbnail || null;
          data.videoUrl = videoData.videoUrl || videoData.playAddr || videoData.url || null;
          data.author.nickname = videoData.author?.nickname || videoData.user?.nickname || null;
          data.author.uniqueId = videoData.author?.uniqueId || videoData.user?.uniqueId || null;
          data.author.avatar = videoData.author?.avatar || videoData.user?.avatar || null;
          data.stats = videoData.stats || {};
        }
      }
    } catch (e) {
      console.error('Error parsing __NEXT_DATA__:', e.message);
    }
  }

  // 2. Look for common meta tags
  const getMeta = (name) => {
    const regex = new RegExp(`<meta[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
    const match = html.match(regex);
    return match ? match[1] : null;
  };

  if (!data.title) data.title = getMeta('og:title') || getMeta('twitter:title');
  if (!data.description) data.description = getMeta('og:description') || getMeta('description');
  if (!data.cover) data.cover = getMeta('og:image') || getMeta('twitter:image');
  if (!data.canonicalUrl) {
    const canonicalRegex = /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i;
    const canonicalMatch = html.match(canonicalRegex);
    if (canonicalMatch) data.canonicalUrl = canonicalMatch[1];
  }

  // 3. Look for JSON in script tags (other common patterns)
  const stateRegex = /(?:window\.)?__INITIAL_STATE__\s*=\s*({[\s\S]*?});/;
  const stateMatch = html.match(stateRegex);
  if (stateMatch) {
    try {
      const json = JSON.parse(stateMatch[1]);
      if (!data.rawJson) data.rawJson = json;
      // Try to extract video data from common paths
      const item = json?.videoData || json?.itemInfo?.itemStruct || json?.data?.video;
      if (item) {
        data.title = item.title || item.desc;
        data.description = item.description || item.desc;
        data.cover = item.cover || item.video?.cover;
        data.videoUrl = item.videoUrl || item.video?.playAddr;
        data.author.nickname = item.author?.nickname;
        data.author.uniqueId = item.author?.uniqueId;
        data.author.avatar = item.author?.avatarLarger || item.author?.avatarMedium;
        data.stats = item.stats || item.statsV2;
      }
    } catch (e) {}
  }

  // 4. Look for video/source tags
  if (!data.videoUrl) {
    const videoTagRegex = /<video[^>]*src=["']([^"']*)["']/i;
    const videoTagMatch = html.match(videoTagRegex);
    if (videoTagMatch) data.videoUrl = videoTagMatch[1];
  }
  if (!data.videoUrl) {
    const sourceTagRegex = /<source[^>]*src=["']([^"']*)["']/i;
    const sourceTagMatch = html.match(sourceTagRegex);
    if (sourceTagMatch) data.videoUrl = sourceTagMatch[1];
  }

  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const tiktokUrl = requestUrl.searchParams.get('url');
  const debug = requestUrl.searchParams.get('debug') === '1';

  if (!tiktokUrl) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing "url" query parameter (TikTok URL)' }));
    return;
  }

  const clipssaverUrl = `https://clipssaver.com/tiktok-profile-viewer/${encodeURIComponent(tiktokUrl)}`;

  try {
    const html = await fetchRenderedHtml(clipssaverUrl);

    if (debug) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end(html);
      return;
    }

    const data = extractFromHtml(html);
    data.source = clipssaverUrl;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to render page', details: error.message }));
  }
};
