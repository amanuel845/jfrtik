const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

function fetchUrl(urlStr, redirects = 0) {
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
        'Cookie': 'tt_webid_v2=7020568976118589446; tt_webid=7020568976118589446;',
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, urlStr).toString();
        res.resume();
        resolve(fetchUrl(redirectUrl, redirects + 1));
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

function extractAuthorData(html) {
  const patterns = [
    {
      name: '__UNIVERSAL_DATA_FOR_REHYDRATION__',
      regex: /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
      parser: (data) => data?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct,
    },
    {
      name: 'SIGI_STATE',
      regex: /<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/,
      parser: (data) => {
        const vm = data?.ItemModule;
        if (!vm) return null;
        const id = Object.keys(vm)[0];
        return id ? vm[id] : null;
      },
    },
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern.regex);
    if (!match) continue;

    try {
      const json = JSON.parse(match[1]);
      const item = pattern.parser(json);
      if (!item) continue;

      const author = item.author || {};
      const authorStats = item.authorStats || {};

      return {
        id: author.id || null,
        uniqueId: author.uniqueId || null,
        nickname: author.nickname || null,
        avatar: author.avatarLarger || author.avatarMedium || author.avatarThumb || null,
        secUid: author.secUid || null,
        stats: {
          followerCount: authorStats.followerCount || 0,
          followingCount: authorStats.followingCount || 0,
          heartCount: authorStats.heartCount || authorStats.heart || 0,
          videoCount: authorStats.videoCount || 0,
          diggCount: authorStats.diggCount || 0,
          friendCount: authorStats.friendCount || 0,
        },
      };
    } catch (e) {
      console.error(`Error parsing ${pattern.name}:`, e.message);
    }
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
  const tiktokUrl = requestUrl.searchParams.get('url');

  if (!tiktokUrl) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
    return;
  }

  if (!/^https?:\/\/(www\.)?(tiktok\.com|vt\.tiktok\.com)\//i.test(tiktokUrl)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid TikTok URL' }));
    return;
  }

  try {
    const html = await fetchUrl(tiktokUrl);
    const data = extractAuthorData(html);
    if (!data) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Author data not found' }));
      return;
    }
    data.fetchedAt = new Date().toISOString();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  } catch (error) {
    console.error('Error:', error.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to fetch author data', details: error.message }));
  }
};
