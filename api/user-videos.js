const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

// Helper to fetch JSON from TikTok internal API
function fetchJson(urlStr) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.tiktok.com/',
        'X-Requested-With': 'XMLHttpRequest',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Cache-Control': 'max-age=0',
        'Cookie': 'tt_webid_v2=7020568976118589446; tt_webid=7020568976118589446;',
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(fetchJson(new URL(res.headers.location, urlStr).toString()));
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
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.end();
  });
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

  // Build TikTok internal API URL
  const apiUrl = `https://www.tiktok.com/api/post/item_list/?secUid=${encodeURIComponent(secUid)}&count=${count}&cursor=${cursor}&aid=1988`;

  try {
    const data = await fetchJson(apiUrl);

    // Extract simplified video items
    const items = (data.itemList || []).map(item => ({
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
      cursor: data.cursor || cursor,
      hasMore: data.hasMore || false,
      items: items,
    }));
  } catch (error) {
    console.error('Error:', error.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to fetch user videos', details: error.message }));
  }
};
