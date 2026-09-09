const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

// fetchUrl function (unchanged)
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

function extractDownloaderData(html) {
  const patterns = [
    {
      name: '__UNIVERSAL_DATA_FOR_REHYDRATION__',
      regex: /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
      parser: (data) => data?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct,
      shareMetaParser: (data) => data?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.shareMeta,
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
      shareMetaParser: (data) => null,
    },
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern.regex);
    if (!match) continue;

    try {
      const json = JSON.parse(match[1]);
      const item = pattern.parser(json);
      if (!item) continue;

      const data = {
        id: item.id || null,
        cover: item.video?.cover || item.video?.originCover || null,
        author: {
          id: item.author?.id || null,
          uniqueId: item.author?.uniqueId || null,
          nickname: item.author?.nickname || null,
          avatar: item.author?.avatarLarger || item.author?.avatarMedium || item.author?.avatarThumb || null,
          secUid: item.author?.secUid || null,
          stats: {
            followerCount: item.authorStats?.followerCount || 0,
            followingCount: item.authorStats?.followingCount || 0,
            heartCount: item.authorStats?.heartCount || item.authorStats?.heart || 0,
            videoCount: item.authorStats?.videoCount || 0,
            diggCount: item.authorStats?.diggCount || 0,
            friendCount: item.authorStats?.friendCount || 0,
          },
        },
        // Use statsV2 if available, otherwise fallback to stats
        stats: item.statsV2 ? {
          diggCount: parseInt(item.statsV2.diggCount || '0'),
          shareCount: parseInt(item.statsV2.shareCount || '0'),
          commentCount: parseInt(item.statsV2.commentCount || '0'),
          playCount: parseInt(item.statsV2.playCount || '0'),
          collectCount: parseInt(item.statsV2.collectCount || '0'),
          repostCount: parseInt(item.statsV2.repostCount || '0'),
        } : {
          diggCount: item.stats?.diggCount || 0,
          shareCount: item.stats?.shareCount || 0,
          commentCount: item.stats?.commentCount || 0,
          playCount: item.stats?.playCount || 0,
          collectCount: item.stats?.collectCount || 0,
          repostCount: item.stats?.repostCount || 0,
        },
        locationCreated: item.locationCreated || null,
        duration: item.video?.duration || null,
        videoSize: item.video?.size || item.video?.PlayAddrStruct?.DataSize || (item.video?.bitrateInfo?.[0]?.PlayAddr?.DataSize) || null,
        createTime: item.createTime || null,
        description: item.desc || item.description || '',
        qualities: [],
        downloadUrl: null,
      };

      // Extract shareMeta desc if available
      const shareMeta = pattern.shareMetaParser ? pattern.shareMetaParser(json) : null;
      if (shareMeta && shareMeta.desc && !data.description) {
        data.description = shareMeta.desc;
      }

      // Collect quality variants
      if (item.video?.bitrateInfo && item.video.bitrateInfo.length > 0) {
        for (const info of item.video.bitrateInfo) {
          const qualityLabel = info.GearName || info.definition || info.QualityType || 'unknown';
          const urls = info.PlayAddr?.UrlList || [];
          if (urls.length > 0) {
            data.qualities.push({
              label: qualityLabel,
              bitrate: info.Bitrate || null,
              urls: urls,
            });
          }
        }
      }

      if (data.qualities.length === 0 && item.video?.playAddr) {
        data.qualities.push({
          label: 'default',
          bitrate: item.video.bitrate || null,
          urls: [item.video.playAddr],
        });
      }

      if (data.qualities.length > 0) {
        data.downloadUrl = data.qualities[0].urls[0];
      }

      return data;
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
    const data = extractDownloaderData(html);
    if (!data) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Video data not found' }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  } catch (error) {
    console.error('Error:', error.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to fetch TikTok video', details: error.message }));
  }
};
