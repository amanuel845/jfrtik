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
        // Add a common TikTok cookie (optional, improves reliability)
        'Cookie': 'tt_webid_v2=7020568976118589446; tt_webid=7020568976118589446; msToken=YOUR_MSTOKEN_HERE;',
      },
    };
    
    const req = https.request(options, (res) => {
      // Handle redirects
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

// Extract video info from TikTok HTML using multiple possible JSON containers
function extractVideoInfo(html) {
  const info = {
    url: null,
    id: null,
    description: null,
    createTime: null,
    scheduleTime: null,
    isAd: false,
    originalItem: false,
    officalItem: false,
    secret: false,
    forFriend: false,
    privateItem: false,
    shareEnabled: false,
    indexEnabled: false,
    duetEnabled: false,
    stitchEnabled: false,
    duetDisplay: 0,
    stitchDisplay: 0,
    takeDown: 0,
    adAuthorization: false,
    adLabelVersion: 0,
    diversificationLabels: [],
    locationCreated: null,
    brandOrganicType: null,
    IsAigc: false,
    AIGCDescription: null,
    ShowAIGC: false,
    textLanguage: null,
    textTranslatable: false,
    CategoryType: null,
    item_control: {},
    video: {
      id: null,
      height: null,
      width: null,
      duration: null,
      ratio: null,
      cover: null,
      originCover: null,
      dynamicCover: null,
      playAddr: null,
      downloadAddr: null,
      bitrate: null,
      format: null,
      codecType: null,
      definition: null,
      videoQuality: null,
      volumeInfo: {},
      subtitleInfos: [],
      zoomCover: {},
      bitrateInfo: [],
      size: null,
      VQScore: null,
      videoID: null,
      PlayAddrStruct: {},
      bitrateInfo: [],
    },
    author: {
      id: null,
      shortId: null,
      uniqueId: null,
      nickname: null,
      avatarLarger: null,
      avatarMedium: null,
      avatarThumb: null,
      signature: null,
      verified: false,
      secUid: null,
      ftc: false,
      relation: 0,
      openFavorite: false,
      commentSetting: 0,
      duetSetting: 0,
      stitchSetting: 0,
      privateAccount: false,
      secret: false,
      isADVirtual: false,
      roomId: null,
      ttSeller: false,
      downloadSetting: 0,
      isEmbedBanned: false,
      canExpPlaylist: false,
      suggestAccountBind: false,
      UserStoryStatus: 0,
      shortDramaCreator: {},
      createTime: null,
      uniqueIdModifyTime: 0,
      nickNameModifyTime: 0,
      recommendReason: null,
      nowInvitationCardUrl: null,
      stats: {
        followerCount: 0,
        followingCount: 0,
        heart: 0,
        heartCount: 0,
        videoCount: 0,
        diggCount: 0,
        friendCount: 0,
      },
    },
    music: {
      id: null,
      title: null,
      playUrl: null,
      coverLarge: null,
      coverMedium: null,
      coverThumb: null,
      authorName: null,
      original: false,
      private: false,
      duration: null,
      collected: false,
      isCopyrighted: false,
      preciseDuration: {},
      shoot_duration: null,
      is_unlimited_music: false,
      is_commerce_music: false,
      tt2dsp: {},
    },
    stats: {
      diggCount: 0,
      shareCount: 0,
      commentCount: 0,
      playCount: 0,
      collectCount: 0,
      repostCount: 0,
    },
    hashtags: [],
    mentions: [],
    warnInfo: [],
    comments: [],
    effectStickers: [],
    stickersOnItem: [],
    contents: [],
    suggestedWords: [],
    channelTags: [],
    diversificationId: null,
    backendSourceEventTracking: null,
    isReviewing: false,
    creatorAIComment: {},
    penaltyContext: {},
    shareMeta: {},
  };

  // Patterns (same as before)
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
    // ... other patterns can be added similarly
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern.regex);
    if (!match) continue;

    try {
      const json = JSON.parse(match[1]);
      const item = pattern.parser(json);
      if (!item) continue;

      // Basic fields
      info.id = item.id || null;
      info.description = item.desc || item.description || null;
      info.createTime = item.createTime || null;
      info.scheduleTime = item.scheduleTime || 0;
      info.isAd = item.isAd || false;
      info.originalItem = item.originalItem || false;
      info.officalItem = item.officalItem || false;
      info.secret = item.secret || false;
      info.forFriend = item.forFriend || false;
      info.privateItem = item.privateItem || false;
      info.shareEnabled = item.shareEnabled || false;
      info.indexEnabled = item.indexEnabled || false;
      info.duetEnabled = item.duetEnabled || false;
      info.stitchEnabled = item.stitchEnabled || false;
      info.duetDisplay = item.duetDisplay || 0;
      info.stitchDisplay = item.stitchDisplay || 0;
      info.takeDown = item.takeDown || 0;
      info.adAuthorization = item.adAuthorization || false;
      info.adLabelVersion = item.adLabelVersion || 0;
      info.diversificationLabels = item.diversificationLabels || [];
      info.locationCreated = item.locationCreated || null;
      info.brandOrganicType = item.brandOrganicType || null;
      info.IsAigc = item.IsAigc || false;
      info.AIGCDescription = item.AIGCDescription || null;
      info.ShowAIGC = item.ShowAIGC || false;
      info.textLanguage = item.textLanguage || null;
      info.textTranslatable = item.textTranslatable || false;
      info.CategoryType = item.CategoryType || null;
      info.item_control = item.item_control || {};
      info.diversificationId = item.diversificationId || null;
      info.backendSourceEventTracking = item.backendSourceEventTracking || null;
      info.isReviewing = item.isReviewing || false;
      info.creatorAIComment = item.creatorAIComment || {};
      info.penaltyContext = item.penaltyContext || {};
      info.warnInfo = item.warnInfo || [];
      info.comments = item.comments || [];
      info.effectStickers = item.effectStickers || [];
      info.stickersOnItem = item.stickersOnItem || [];
      info.contents = item.contents || [];
      info.suggestedWords = item.suggestedWords || [];
      info.channelTags = item.channelTags || [];

      // Video
      if (item.video) {
        const v = item.video;
        info.video = {
          id: v.id || item.id,
          height: v.height || null,
          width: v.width || null,
          duration: v.duration || null,
          ratio: v.ratio || null,
          cover: v.cover || null,
          originCover: v.originCover || null,
          dynamicCover: v.dynamicCover || null,
          playAddr: v.playAddr || null,
          downloadAddr: v.downloadAddr || null,
          bitrate: v.bitrate || null,
          format: v.format || null,
          codecType: v.codecType || null,
          definition: v.definition || null,
          videoQuality: v.videoQuality || null,
          volumeInfo: v.volumeInfo || {},
          subtitleInfos: v.subtitleInfos || [],
          zoomCover: v.zoomCover || {},
          bitrateInfo: v.bitrateInfo || [],
          size: v.size || null,
          VQScore: v.VQScore || null,
          videoID: v.videoID || null,
          PlayAddrStruct: v.PlayAddrStruct || {},
        };
      }

      // Author
      if (item.author) {
        const a = item.author;
        info.author = {
          id: a.id || null,
          shortId: a.shortId || null,
          uniqueId: a.uniqueId || null,
          nickname: a.nickname || null,
          avatarLarger: a.avatarLarger || null,
          avatarMedium: a.avatarMedium || null,
          avatarThumb: a.avatarThumb || null,
          signature: a.signature || null,
          verified: a.verified || false,
          secUid: a.secUid || null,
          ftc: a.ftc || false,
          relation: a.relation || 0,
          openFavorite: a.openFavorite || false,
          commentSetting: a.commentSetting || 0,
          duetSetting: a.duetSetting || 0,
          stitchSetting: a.stitchSetting || 0,
          privateAccount: a.privateAccount || false,
          secret: a.secret || false,
          isADVirtual: a.isADVirtual || false,
          roomId: a.roomId || null,
          ttSeller: a.ttSeller || false,
          downloadSetting: a.downloadSetting || 0,
          isEmbedBanned: a.isEmbedBanned || false,
          canExpPlaylist: a.canExpPlaylist || false,
          suggestAccountBind: a.suggestAccountBind || false,
          UserStoryStatus: a.UserStoryStatus || 0,
          shortDramaCreator: a.shortDramaCreator || {},
          createTime: a.createTime || null,
          uniqueIdModifyTime: a.uniqueIdModifyTime || 0,
          nickNameModifyTime: a.nickNameModifyTime || 0,
          recommendReason: a.recommendReason || null,
          nowInvitationCardUrl: a.nowInvitationCardUrl || null,
          stats: {
            followerCount: item.authorStats?.followerCount || 0,
            followingCount: item.authorStats?.followingCount || 0,
            heart: item.authorStats?.heart || 0,
            heartCount: item.authorStats?.heartCount || 0,
            videoCount: item.authorStats?.videoCount || 0,
            diggCount: item.authorStats?.diggCount || 0,
            friendCount: item.authorStats?.friendCount || 0,
          },
        };
      }

      // Music
      if (item.music) {
        const m = item.music;
        info.music = {
          id: m.id || null,
          title: m.title || null,
          playUrl: m.playUrl || null,
          coverLarge: m.coverLarge || null,
          coverMedium: m.coverMedium || null,
          coverThumb: m.coverThumb || null,
          authorName: m.authorName || null,
          original: m.original || false,
          private: m.private || false,
          duration: m.duration || null,
          collected: m.collected || false,
          isCopyrighted: m.isCopyrighted || false,
          preciseDuration: m.preciseDuration || {},
          shoot_duration: m.shoot_duration || null,
          is_unlimited_music: m.is_unlimited_music || false,
          is_commerce_music: m.is_commerce_music || false,
          tt2dsp: m.tt2dsp || {},
        };
      }

      // Stats
      if (item.stats) {
        info.stats = {
          diggCount: item.stats.diggCount || 0,
          shareCount: item.stats.shareCount || 0,
          commentCount: item.stats.commentCount || 0,
          playCount: item.stats.playCount || 0,
          collectCount: item.stats.collectCount || 0,
          repostCount: item.stats.repostCount || 0,
        };
      } else if (item.statsV2) {
        info.stats = {
          diggCount: parseInt(item.statsV2.diggCount || '0'),
          shareCount: parseInt(item.statsV2.shareCount || '0'),
          commentCount: parseInt(item.statsV2.commentCount || '0'),
          playCount: parseInt(item.statsV2.playCount || '0'),
          collectCount: parseInt(item.statsV2.collectCount || '0'),
          repostCount: parseInt(item.statsV2.repostCount || '0'),
        };
      }

      // Hashtags and mentions
      if (item.challenges) {
        info.hashtags = item.challenges.map(c => c.title || c.name || '').filter(Boolean);
      }
      if (item.textExtra) {
        info.mentions = item.textExtra
          .filter(extra => extra.type === 0)
          .map(extra => extra.userUniqueId)
          .filter(Boolean);
        // Also collect hashtags from textExtra (type 1)
        const textHashtags = item.textExtra
          .filter(extra => extra.type === 1)
          .map(extra => extra.hashtagName)
          .filter(Boolean);
        info.hashtags = [...new Set([...info.hashtags, ...textHashtags])];
      }

      // Share meta (outside itemStruct)
      const shareMeta = pattern.shareMetaParser ? pattern.shareMetaParser(json) : null;
      if (shareMeta) {
        info.shareMeta = shareMeta;
      }

      return info;
    } catch (e) {
      console.error(`Error parsing ${pattern.name}:`, e.message);
    }
  }

  return info;
}

// Export the serverless function handler
module.exports = async function handler(req, res) {
  // CORS headers
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
    console.log(`Fetching ${tiktokUrl}`);
    const html = await fetchUrl(tiktokUrl);
    console.log(`Received HTML length: ${html.length}`);
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
