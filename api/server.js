const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

// Helper: perform an HTTPS request with redirect following and decompression
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
      },
    };

    const req = https.request(options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, urlStr).toString();
        res.resume(); // discard body
        resolve(fetchUrl(redirectUrl, redirects + 1));
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Request failed with status ${res.statusCode}`));
        return;
      }

      // Decompress response if needed
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

// Extract video info from TikTok HTML
function extractVideoInfo(html) {
  const info = {
    url: null,
    id: null,
    description: null,
    author: {
      id: null,
      uniqueId: null,
      nickname: null,
      avatarLarger: null,
      signature: null,
      verified: false,
    },
    statistics: {
      diggCount: 0,
      shareCount: 0,
      commentCount: 0,
      playCount: 0,
    },
    video: {
      cover: null,
      dynamicCover: null,
      playAddr: null,
      downloadAddr: null,
      duration: null,
      ratio: null,
      format: null,
    },
    music: {
      id: null,
      title: null,
      playUrl: null,
      coverLarge: null,
      authorName: null,
    },
    createTime: null,
    isAd: false,
  };

  // Try to find JSON in <script id="SIGI_STATE"> or similar
  const sigiStateRegex = /<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/;
  const sigiMatch = html.match(sigiStateRegex);
  if (sigiMatch) {
    try {
      const data = JSON.parse(sigiMatch[1]);
      const videoModule = data?.ItemModule;
      const userModule = data?.UserModule;
      const musicModule = data?.MusicModule;
      if (videoModule) {
        const videoId = Object.keys(videoModule)[0];
        if (videoId) {
          const item = videoModule[videoId];
          info.id = item.id;
          info.description = item.desc;
          info.createTime = item.createTime;
          info.isAd = item.isAd || false;
          info.statistics = {
            diggCount: item.stats?.diggCount || 0,
            shareCount: item.stats?.shareCount || 0,
            commentCount: item.stats?.commentCount || 0,
            playCount: item.stats?.playCount || 0,
          };
          info.video = {
            cover: item.video?.cover,
            dynamicCover: item.video?.dynamicCover,
            playAddr: item.video?.playAddr,
            downloadAddr: item.video?.downloadAddr,
            duration: item.video?.duration,
            ratio: item.video?.ratio,
            format: item.video?.format,
          };
        }
      }
      if (userModule && info.id) {
        const authorId = data?.ItemModule?.[info.id]?.authorId;
        if (authorId && userModule[authorId]) {
          const user = userModule[authorId];
          info.author = {
            id: user.id,
            uniqueId: user.uniqueId,
            nickname: user.nickname,
            avatarLarger: user.avatarLarger,
            signature: user.signature,
            verified: user.verified || false,
          };
        }
      }
      if (musicModule && info.id) {
        const musicId = data?.ItemModule?.[info.id]?.musicId;
        if (musicId && musicModule[musicId]) {
          const music = musicModule[musicId];
          info.music = {
            id: music.id,
            title: music.title,
            playUrl: music.playUrl,
            coverLarge: music.coverLarge,
            authorName: music.authorName,
          };
        }
      }
      return info;
    } catch (e) {
      console.error('Error parsing SIGI_STATE JSON:', e);
    }
  }

  // Alternative: try to find JSON in window._SIG_I_H_ or similar
  const windowSigiRegex = /window\._SIG_I_H_\s*=\s*({[\s\S]*?});/;
  const windowMatch = html.match(windowSigiRegex);
  if (windowMatch) {
    try {
      const data = JSON.parse(windowMatch[1]);
      // Structure may be similar; you can add similar extraction here if needed
      // For brevity, we skip detailed extraction.
    } catch (e) {
      console.error('Error parsing window._SIG_I_H_ JSON:', e);
    }
  }

  return info;
}

// Export the serverless function handler
module.exports = async function handler(req, res) {
  // Enable CORS (optional, adjust as needed)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  // Parse query parameters from req.url
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const tiktokUrl = requestUrl.searchParams.get('url');

  if (!tiktokUrl) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
    return;
  }

  // Basic validation
  if (!/^https?:\/\/(www\.)?(tiktok\.com|vt\.tiktok\.com)\//i.test(tiktokUrl)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid TikTok URL' }));
    return;
  }

  try {
    console.log(`Fetching ${tiktokUrl}`);
    const html = await fetchUrl(tiktokUrl);
    const info = extractVideoInfo(html);
    info.url = tiktokUrl;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(info, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to fetch TikTok video info', details: error.message }));
  }
};
