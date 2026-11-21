const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

require('dotenv').config();

require('../../utils/axios.utils');

// DOMPurify needs a DOM; jsdom provides one in Node.
const DOMPurify = createDOMPurify(new JSDOM('').window);

// Only tags Telegram's Bot API renders (parse_mode=HTML).
const TELEGRAM_ALLOWED_TAGS = [
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'a',
  'code',
  'pre',
];

const TNHB_ANNOUNCEMENTS_API_URL = process.env.TNHB_ANNOUNCEMENTS_API_URL || '';
const TNHB_TELEGRAM_API_TOKEN = process.env.TNHB_TELEGRAM_API_TOKEN || '';
const TNHB_TELEGRAM_CHAT_ID = process.env.TNHB_TELEGRAM_CHAT_ID || '';
const PROXY_API_URL = process.env.PROXY_API_URL || '';
const PROXY_API_KEY = process.env.PROXY_API_KEY || '';

const CACHE_FILE_PATH = path.join('.cache', 'tnhb-announcements.json');

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;
// Chunk on composed HTML length; DOMPurify only ever shrinks it, so the
// sent payload stays within Telegram's 4096-char limit.
const TELEGRAM_MAX_LENGTH = 4000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Highest notification id is the monotonic "latest seen" watermark.
const getMaxId = (data) => {
  const notifications =
    data && Array.isArray(data.notifications) ? data.notifications : [];
  const ids = notifications
    .map((item) => Number(item && item.id))
    .filter((id) => Number.isFinite(id));

  return ids.length > 0 ? Math.max(...ids) : 0;
};

const isRetryable = (error) => {
  if (!error.response) {
    return true; // Network error / timeout / DNS
  }

  const { status } = error.response;

  return status === 408 || status === 429 || (status >= 500 && status <= 599);
};

const readCache = () => {
  try {
    if (!fs.existsSync(CACHE_FILE_PATH)) {
      return null;
    }

    const raw = fs.readFileSync(CACHE_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.data &&
      Array.isArray(parsed.data.notifications)
    ) {
      // Legacy caches stored `etag` instead of `maxId`. Deriving the watermark
      // from the saved snapshot keeps the first run after this change silent.
      const storedMaxId = Number(parsed.maxId);
      const maxId = Number.isFinite(storedMaxId)
        ? storedMaxId
        : getMaxId(parsed.data);

      return { maxId, data: parsed.data };
    }

    return null;
  } catch (error) {
    console.error(`Failed to read cache file: ${error.message}`);

    return null;
  }
};

const writeCache = (maxId, data) => {
  fs.mkdirSync(path.dirname(CACHE_FILE_PATH), { recursive: true });
  fs.writeFileSync(
    CACHE_FILE_PATH,
    JSON.stringify({ maxId, data }, null, 2),
    'utf8',
  );
};

const appendGithubOutput = (lines) => {
  const outputFile = process.env.GITHUB_OUTPUT;

  if (!outputFile) {
    return;
  }

  try {
    fs.appendFileSync(outputFile, `${lines.join('\n')}\n`, 'utf8');
  } catch (error) {
    console.error(`Failed to write GITHUB_OUTPUT: ${error.message}`);
  }
};

const fetchAnnouncements = async (url) => {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await axios.get(url);

      return response;
    } catch (error) {
      lastError = error;

      const retryable = isRetryable(error);
      const status = error.response ? error.response.status : 'NO_RESPONSE';

      console.error(
        `TNHB API request failed (attempt ${attempt}/${MAX_ATTEMPTS}, status: ${status}).`,
      );

      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw error;
      }

      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);

      console.info(`Retrying in ${delay}ms (exponential backoff)...`);
      await sleep(delay);
    }
  }

  throw lastError;
};

const parseCreatedAt = (value) => {
  const time = new Date(value).getTime();

  return Number.isNaN(time) ? 0 : time;
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

const sanitizeText = (value) =>
  String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const escapeHtml = (value) =>
  sanitizeText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// DOMPurify allowlist so only tags Telegram renders (parse_mode=HTML)
// survive in the sent message.
const toSafeTelegramHtml = (html) =>
  DOMPurify.sanitize(html, {
    ALLOWED_TAGS: TELEGRAM_ALLOWED_TAGS,
    ALLOWED_ATTR: ['href'],
  });

const composeDigestMessages = (delta) => {
  const header = `🏠 <b>TNHB Announcements (${delta.length} new)</b>`;
  const chunks = [];
  let current = header;
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

  orderedGroups.forEach(([dateLabel, group]) => {
    const dateBlock = `\n\n📅 <b>${escapeHtml(dateLabel)}</b>`;

    if ((current + dateBlock).length > TELEGRAM_MAX_LENGTH) {
      chunks.push(current);
      current = '🏠 <b>TNHB Announcements (contd.)</b>';
    }
    current += dateBlock;

    group.items.forEach((item) => {
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

      if ((current + block).length > TELEGRAM_MAX_LENGTH) {
        chunks.push(current);
        current = `🏠 <b>TNHB Announcements (contd.)</b>\n\n📅 <b>${escapeHtml(dateLabel)}</b>`;
      }
      current += block;
    });
  });

  chunks.push(current);

  return chunks;
};

const sendMessage = async (html) => {
  const url = `https://api.telegram.org/bot${TNHB_TELEGRAM_API_TOKEN}/sendMessage`;
  const text = toSafeTelegramHtml(html);

  const { data } = await axios
    .post(url, {
      chat_id: TNHB_TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
    .catch((error) => {
      // Custom message only: Telegram's one-line diagnosis when present,
      // otherwise a short fallback. Never dump the axios error object
      // (verbose, and its config echoes the bot token URL).
      const apiBody =
        error.response && error.response.data ? error.response.data : null;

      console.error(
        apiBody && apiBody.description
          ? `Telegram API error: ${apiBody.description}.`
          : 'Telegram sendMessage request failed (no response).',
      );
      // Log the payload that failed (token/chat_id live in the request
      // URL/body, never in `text`, so this is safe to print).
      console.error(`Telegram message payload: ${text}`);

      return Promise.reject(error);
    });

  return !!(data && data.ok);
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

  const cached = readCache();

  const proxiedUrl = new URL(PROXY_API_URL);
  proxiedUrl.searchParams.set('api_key', PROXY_API_KEY);
  proxiedUrl.searchParams.set('url', TNHB_ANNOUNCEMENTS_API_URL);
  proxiedUrl.searchParams.set('country_code', 'in');
  proxiedUrl.searchParams.set('keep_headers', 'true');

  let response;
  try {
    response = await fetchAnnouncements(proxiedUrl.toString());
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
    writeCache(newMaxId, newData);
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

  if (changed) {
    writeCache(Math.max(cached.maxId, newMaxId), newData);
  }

  appendGithubOutput([
    `changed=${changed}`,
    'notified=false',
    `cache_key=${cacheKey}`,
  ]);

  if (delta.length === 0) {
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
    const sent = await sendMessage(message);

    if (!sent) {
      console.error(
        `Failed to send digest chunk ${index + 1}/${messages.length}.`,
      );

      process.exit(1);
    }
  }

  console.info(`Message sent! (${delta.length} new notification(s).)`);
  appendGithubOutput(['notified=true']);
})();
