const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

require('dotenv').config();

require('./axios.utils');

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

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;
// Chunk on composed HTML length; DOMPurify only ever shrinks it, so the
// sent payload stays within Telegram's 4096-char limit.
const TELEGRAM_MAX_LENGTH = 4000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every API value is normalized before comparison or rendering.
const clean = (value) =>
  (value === null || value === undefined ? '' : String(value))
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const escapeHtml = (value) =>
  clean(value)
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

const parseCreatedAt = (value) => {
  const time = new Date(clean(value)).getTime();

  return Number.isNaN(time) ? 0 : time;
};

const isRetryable = (error) => {
  if (!error.response) {
    return true; // Network error / timeout / DNS
  }

  const { status } = error.response;

  return status === 408 || status === 429 || (status >= 500 && status <= 599);
};

const fetchWithRetry = async (
  url,
  { method = 'GET', data, label = 'TNHB API' } = {},
) => {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      if (method === 'POST') {
        return await axios.post(url, data);
      }

      return await axios.get(url);
    } catch (error) {
      lastError = error;

      const retryable = isRetryable(error);
      const status = error.response ? error.response.status : 'NO_RESPONSE';

      console.error(
        `${label} request failed (attempt ${attempt}/${MAX_ATTEMPTS}, status: ${status}).`,
      );

      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw error;
      }

      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);

      console.info(`Retrying in ${delay}ms (exponential backoff)...`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
    }
  }

  throw lastError;
};

const buildProxiedUrl = (
  targetUrl,
  proxyUrl = process.env.PROXY_API_URL || '',
  apiKey = process.env.PROXY_API_KEY || '',
) => {
  const proxiedUrl = new URL(proxyUrl);

  proxiedUrl.searchParams.set('api_key', apiKey);
  proxiedUrl.searchParams.set('url', targetUrl);
  proxiedUrl.searchParams.set('country_code', 'in');
  proxiedUrl.searchParams.set('keep_headers', 'true');

  return proxiedUrl.toString();
};

const readCache = (filePath, isValid) => {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    return isValid(parsed) ? parsed : null;
  } catch (error) {
    console.error(`Failed to read cache file: ${error.message}`);

    return null;
  }
};

const writeCache = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
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

// `sections` items: { intro, continuationIntro, blocks }.
const chunkDigest = ({ header, continuationHeader, sections }) => {
  const chunks = [];
  let current = header;

  sections.forEach(({ intro, continuationIntro = '', blocks }) => {
    if ((current + intro).length > TELEGRAM_MAX_LENGTH) {
      chunks.push(current);
      current = continuationHeader;
    }

    current += intro;

    blocks.forEach((block) => {
      if ((current + block).length > TELEGRAM_MAX_LENGTH) {
        chunks.push(current);
        current = `${continuationHeader}${continuationIntro}`;
      }

      current += block;
    });
  });

  chunks.push(current);

  return chunks;
};

const sendMessage = async (
  html,
  token = process.env.TNHB_TELEGRAM_API_TOKEN || '',
  chatId = process.env.TNHB_TELEGRAM_CHAT_ID || '',
) => {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const text = toSafeTelegramHtml(html);

  const { data } = await axios
    .post(url, {
      chat_id: chatId,
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

module.exports = {
  TELEGRAM_MAX_LENGTH,
  clean,
  escapeHtml,
  toSafeTelegramHtml,
  parseCreatedAt,
  fetchWithRetry,
  buildProxiedUrl,
  readCache,
  writeCache,
  appendGithubOutput,
  chunkDigest,
  sendMessage,
};
