const path = require('path');

const {
  escapeHtml,
  parseCreatedAt,
  fetchWithRetry,
  buildProxiedUrl,
  readCache,
  writeCache,
  appendGithubOutput,
  chunkDigest,
  sendMessage,
} = require('../../utils/tnhb-notifier.utils');

const TNHB_ANNOUNCEMENTS_API_URL = process.env.TNHB_ANNOUNCEMENTS_API_URL || '';
const TNHB_TELEGRAM_API_TOKEN = process.env.TNHB_TELEGRAM_API_TOKEN || '';
const TNHB_TELEGRAM_CHAT_ID = process.env.TNHB_TELEGRAM_CHAT_ID || '';
const PROXY_API_URL = process.env.PROXY_API_URL || '';
const PROXY_API_KEY = process.env.PROXY_API_KEY || '';

const CACHE_FILE_PATH = path.join('.cache', 'tnhb-announcements.json');

// Highest notification id is the monotonic "latest seen" watermark.
const getMaxId = (data) => {
  const notifications =
    data && Array.isArray(data.notifications) ? data.notifications : [];
  const ids = notifications
    .map((item) => Number(item && item.id))
    .filter((id) => Number.isFinite(id));

  return ids.length > 0 ? Math.max(...ids) : 0;
};

const readAnnouncementsCache = () => {
  const cached = readCache(
    CACHE_FILE_PATH,
    (parsed) =>
      parsed &&
      typeof parsed === 'object' &&
      parsed.data &&
      Array.isArray(parsed.data.notifications),
  );

  if (!cached) {
    return null;
  }

  // Legacy caches stored `etag` instead of `maxId`. Deriving the watermark
  // from the saved snapshot keeps the first run after this change silent.
  const storedMaxId = Number(cached.maxId);

  return {
    maxId: Number.isFinite(storedMaxId) ? storedMaxId : getMaxId(cached.data),
    data: cached.data,
  };
};

const formatDateOnly = (value) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Unknown date';
  }

  return date.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const getDelta = (oldData, newData, previousMaxId) => {
  const oldIds = new Set(
    (oldData.notifications || []).map((item) => item && item.id),
  );

  return (newData.notifications || [])
    .filter(
      (item) =>
        item &&
        // Primary signal: id above the last-seen high-water mark.
        // Also include unseen lower ids to catch backdated inserts.
        (Number(item.id) > previousMaxId || !oldIds.has(item.id)),
    )
    .sort(
      (a, b) => parseCreatedAt(b.created_at) - parseCreatedAt(a.created_at),
    );
};

const composeDigestMessages = (delta) => {
  let counter = 0;

  // Group by IST calendar date, latest date first (delta is already latest-first).
  const groups = new Map();
  delta.forEach((item) => {
    const dateLabel = formatDateOnly(item.created_at);

    if (!groups.has(dateLabel)) {
      groups.set(dateLabel, { sortTime: 0, items: [] });
    }

    const group = groups.get(dateLabel);
    group.sortTime = Math.max(group.sortTime, parseCreatedAt(item.created_at));
    group.items.push(item);
  });

  const orderedGroups = [...groups.entries()].sort(
    (a, b) => b[1].sortTime - a[1].sortTime,
  );
  const sections = orderedGroups.map(([dateLabel, group]) => {
    const dateBlock = `\n\n📅 <b>${escapeHtml(dateLabel)}</b>`;
    const blocks = group.items.map((item) => {
      counter += 1;

      const title = escapeHtml(item.title || 'Untitled');
      const pdfs = Array.isArray(item.pdfs_urls) ? item.pdfs_urls : [];

      let block = `\n\n<b>${counter}. ${title}</b>`;

      if (pdfs.length > 0) {
        const links = pdfs
          .map((pdf, pdfIndex) => {
            const url = pdf && pdf.local_url ? String(pdf.local_url) : '';

            if (!url) {
              return '';
            }

            const label = pdfs.length > 1 ? `PDF ${pdfIndex + 1}` : 'PDF';

            return `📎 <a href="${escapeHtml(url)}">${label}</a>`;
          })
          .filter(Boolean)
          .join(' | ');

        block += links ? `\n${links}` : '\nNo attachments';
      } else {
        block += '\nNo attachments';
      }

      return block;
    });

    return { intro: dateBlock, continuationIntro: dateBlock, blocks };
  });

  return chunkDigest({
    header: `🏠 <b>TNHB Announcements (${delta.length} new)</b>`,
    continuationHeader: '🏠 <b>TNHB Announcements (contd.)</b>',
    sections,
  });
};

(async () => {
  if (!TNHB_ANNOUNCEMENTS_API_URL) {
    console.error('TNHB_ANNOUNCEMENTS_API_URL is empty!');

    process.exit(1);
  }

  if (!PROXY_API_URL || !PROXY_API_KEY) {
    console.error('PROXY_API_URL or PROXY_API_KEY is empty!');

    process.exit(1);
  }

  const cached = readAnnouncementsCache();

  let response;
  try {
    response = await fetchWithRetry(
      buildProxiedUrl(
        TNHB_ANNOUNCEMENTS_API_URL,
        PROXY_API_URL,
        PROXY_API_KEY,
      ),
      { label: 'TNHB API' },
    );
  } catch (error) {
    console.error('API failed after 3 attempts.');

    process.exit(1);
  }

  const newData = response.data;

  if (!newData || !Array.isArray(newData.notifications)) {
    console.error(
      'Unexpected API response shape; expected { notifications: [] }.',
    );

    process.exit(1);
  }

  const newMaxId = getMaxId(newData);
  // GitHub cache keys are immutable, so every save needs a fresh key.
  const cacheKey = `tnhb-${newMaxId}-${Date.now()}`;

  // First run (no cache): seed the cache file silently, notify nothing.
  if (!cached) {
    writeCache(CACHE_FILE_PATH, { maxId: newMaxId, data: newData });
    console.info(
      `First run: cached ${newData.notifications.length} notification(s). No message sent.`,
    );
    appendGithubOutput([
      'changed=true',
      'notified=false',
      `cache_key=${cacheKey}`,
    ]);

    return;
  }

  const delta = getDelta(cached.data, newData, cached.maxId);
  const payloadChanged =
    JSON.stringify(cached.data) !== JSON.stringify(newData);
  // Only new ids trigger a digest; payload edits refresh the snapshot without
  // re-sending announcements that were already delivered.
  const changed = delta.length > 0 || payloadChanged;
  const persistedMaxId = Math.max(cached.maxId, newMaxId);

  appendGithubOutput([
    `changed=${changed}`,
    'notified=false',
    `cache_key=${cacheKey}`,
  ]);

  if (delta.length === 0) {
    // Payload edits still refresh the snapshot, but no digest is sent.
    if (changed) {
      writeCache(CACHE_FILE_PATH, { maxId: persistedMaxId, data: newData });
    }

    console.info(
      'Response changed but no new notification IDs. Nothing to send.',
    );

    return;
  }

  if (!TNHB_TELEGRAM_API_TOKEN || !TNHB_TELEGRAM_CHAT_ID) {
    console.error('Telegram credentials are empty; cannot send digest.');

    process.exit(1);
  }

  const messages = composeDigestMessages(delta);

  for (const [index, message] of messages.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const sent = await sendMessage(
      message,
      TNHB_TELEGRAM_API_TOKEN,
      TNHB_TELEGRAM_CHAT_ID,
    );

    if (!sent) {
      console.error(
        `Failed to send digest chunk ${index + 1}/${messages.length}.`,
      );

      process.exit(1);
    }
  }

  // Advance the watermark only after every chunk was delivered, so a failed
  // send is retried on the next run instead of losing the notification.
  writeCache(CACHE_FILE_PATH, { maxId: persistedMaxId, data: newData });

  console.info(`Message sent! (${delta.length} new notification(s).)`);
  appendGithubOutput(['notified=true']);
})();
