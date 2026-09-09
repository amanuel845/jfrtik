const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

// fetchUrl helper (same as in other endpoints)
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
      if (encoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      } else if (encoding === 'br') {
        stream = res.pipe(zlib.createBrotliDecompress());
      }
      
      const decoder = new StringDecoder('utf-8');
      let body = '';
      stream.on('data', (chunk) => {
        body += decoder.write(chunk);
      });
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


// extractVideoUrls helper (same as in downloader.js)
function extractVideoUrls(html) {
  const urls = [];
  
  // Primary pattern: __UNIVERSAL_DATA_FOR_REHYDRATION__
  const regex = /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/;
  const match = html.match(regex);
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      const itemStruct = data?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct;
      if (itemStruct && itemStruct.video) {
        // Direct playAddr
        if (itemStruct.video.playAddr) {
          urls.push(itemStruct.video.playAddr);
        }
        // bitrateInfo PlayAddr.UrlList
        if (itemStruct.video.bitrateInfo) {
          for (const info of itemStruct.video.bitrateInfo) {
            if (info.PlayAddr?.UrlList) {
              urls.push(...info.PlayAddr.UrlList);
            }
          }
        }
        // PlayAddrStruct.UrlList
        if (itemStruct.video.PlayAddrStruct?.UrlList) {
          urls.push(...itemStruct.video.PlayAddrStruct.UrlList);
        }
      }
    } catch (e) {
      console.error('Error parsing JSON:', e);
    }
  }
  
  // Deduplicate
  return [...new Set(urls)];
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
    const videoUrls = extractVideoUrls(html);
    
    if (videoUrls.length === 0) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'No video URL found' }));
      return;
    }
    
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: true,
      urls: videoUrls,
      // Optional: include a direct playAddr as the first URL
      playAddr: videoUrls[0],
      // Note: URLs are time-limited and may require specific headers
    }));
  } catch (error) {
    console.error('Error:', error.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to fetch TikTok page', details: error.message }));
  }
};
