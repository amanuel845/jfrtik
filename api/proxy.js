const https = require('https');
const { URL } = require('url');

// Only allow requests to known TikTok CDN hosts to prevent an open proxy
const ALLOWED_HOST_SUFFIXES = [
  '.tiktokcdn.com',
  '.tiktokcdn-us.com',
  '.tiktokv.com',
  '.tiktokv.us',
  '.tiktok.com',
  '.ibytedtos.com',
  '.byteoversea.com',
  '.muscdn.com',
];

function isAllowedHost(hostname) {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix) || host === suffix.slice(1));
}

function proxyStream(urlStr, req, res, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('Too many redirects'));
      return;
    }

    const parsedUrl = new URL(urlStr);

    if (!isAllowedHost(parsedUrl.hostname)) {
      reject(new Error('Host not allowed'));
      return;
    }

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.tiktok.com/',
        'Connection': 'keep-alive',
      },
    };

    const upstream = https.request(options, (upRes) => {
      // Follow redirects
      if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location) {
        const nextUrl = new URL(upRes.headers.location, urlStr).toString();
        upRes.resume();
        resolve(proxyStream(nextUrl, req, res, redirects + 1));
        return;
      }

      if (upRes.statusCode !== 200) {
        upRes.resume();
        reject(new Error(`Upstream responded ${upRes.statusCode}`));
        return;
      }

      // Copy relevant headers to the client
      const contentType = upRes.headers['content-type'] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Cache-Control', 'public, max-age=300');
      if (upRes.headers['content-length']) {
        res.setHeader('Content-Length', upRes.headers['content-length']);
      }

      res.statusCode = 200;
      upRes.pipe(res);
      upRes.on('end', () => resolve());
      upRes.on('error', reject);
    });

    upstream.on('error', reject);
    upstream.end();
  });
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 200;
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const targetUrl = requestUrl.searchParams.get('url');

  if (!targetUrl) {
    res.statusCode = 400;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
    return;
  }

  try {
    await proxyStream(targetUrl, req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Proxy failed', details: error.message }));
    }
  }
};
