const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

// Helper to fetch raw text with redirects and decompression
function fetchText(urlStr, redirects = 0, headers = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) {
      reject(new Error('Too many redirects'));
      return;
    }

    const parsedUrl = new URL(urlStr);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, urlStr).toString();
        res.resume();
        resolve(fetchText(redirectUrl, redirects + 1, headers));
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Request failed with status ${res.statusCode}`));
        return;
      }

      let stream = res;
      const encoding = res.headers['content-encoding'];
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      const decoder = new StringDecoder('utf-8');
      let body = '';
      stream.on('data', (chunk) => body += decoder.write(chunk));
      stream.on('end', () => {
        body += decoder.end();
        resolve(body);
      });
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.end();
  });
}

// Extract video list from user profile page HTML
function extractUserVideosFromHtml(html) {
  // Try __UNIVERSAL_DATA_FOR_REHYDRATION__ first
  const pattern = /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/;
  const match = html.match(pattern);
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      const itemList = data?.['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.userInfo?.user?.videoList;
      if (itemList) return itemList;
    } catch (e) {}
  }

  // Fallback to SIGI_STATE
  const sigiPattern = /<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/;
  const sigiMatch = html.match(sigiPattern);
  if (sigiMatch) {
    try {
      const data = JSON.parse(sigiMatch[1]);
      const itemList = data?.ItemModule;
      if (itemList) return Object.values(itemList);
    } catch (e) {}
  }

  return null;
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
  const secUid = requestUrl.searchParams.get('secUid');
  const count = parseInt(requestUrl.searchParams.get('count') || '30');
  const cursor = parseInt(requestUrl.searchParams.get('cursor') || '0');

  if (!secUid) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing "secUid" query parameter' }));
    return;
  }

  // First, try the internal JSON API
  const apiUrl = `https://www.tiktok.com/api/post/item_list/?secUid=${encodeURIComponent(secUid)}&count=${count}&cursor=${cursor}&aid=1988`;

  try {
    const apiResponseText = await fetchText(apiUrl, 0, {
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `https://www.tiktok.com/@user/video`,
    });

    let apiData;
    try {
      apiData = JSON.parse(apiResponseText);
    } catch (e) {
      // If JSON parsing fails, fall back to scraping the profile page
      console.warn('API returned non-JSON, falling back to profile scrape');
      const profileUrl = `https://www.tiktok.com/@user?secUid=${encodeURIComponent(secUid)}`;
      const profileHtml = await fetchText(profileUrl);
      const items = extractUserVideosFromHtml(profileHtml);

      if (!items) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Failed to fetch user videos', details: 'Could not parse JSON or HTML' }));
        return;
      }

      const simplifiedItems = items.map(item => ({
        id: item.id,
        desc: item.desc,
        cover: item.video?.cover || item.video?.originCover || '',
        playAddr: item.video?.playAddr || '',
        stats: item.stats || {},
        createTime: item.createTime,
      }));

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: true,
        cursor: cursor,
        hasMore: false,
        items: simplifiedItems,
      }));
      return;
    }

    // If API JSON parsing succeeded, use it
    const items = (apiData.itemList || []).map(item => ({
      id: item.id,
      desc: item.desc,
      cover: item.video?.cover || item.video?.originCover || '',
      playAddr: item.video?.playAddr || '',
      stats: item.stats || {},
      createTime: item.createTime,
    }));

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: true,
      cursor: apiData.cursor || cursor,
      hasMore: apiData.hasMore || false,
      items: items,
    }));

  } catch (error) {
    console.error('Error:', error.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to fetch user videos', details: error.message }));
  }
};
