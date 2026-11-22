const path = require('path');

const {
  clean,
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

const TNHB_UPCOMING_PROJECTS_API_URL =
  process.env.TNHB_UPCOMING_PROJECTS_API_URL || '';
const TNHB_INTEREST_REGISTRATION_URL =
  process.env.TNHB_INTEREST_REGISTRATION_URL || '';
const TNHB_TELEGRAM_API_TOKEN = process.env.TNHB_TELEGRAM_API_TOKEN || '';
const TNHB_TELEGRAM_CHAT_ID = process.env.TNHB_TELEGRAM_CHAT_ID || '';
const PROXY_API_URL = process.env.PROXY_API_URL || '';
const PROXY_API_KEY = process.env.PROXY_API_KEY || '';

const CACHE_FILE_PATH = path.join('.cache', 'tnhb-upcoming-projects.json');

// Normalize to a trailing slash so the project id can simply be appended.
const registrationUrlPrefix = clean(TNHB_INTEREST_REGISTRATION_URL)
  ? `${clean(TNHB_INTEREST_REGISTRATION_URL).replace(/\/+$/, '')}/`
  : '';

const textOrDash = (value) => escapeHtml(value) || '--';

const readProjectsCache = () =>
  readCache(
    CACHE_FILE_PATH,
    (parsed) =>
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray(parsed.ids) &&
      Array.isArray(parsed.snapshot),
  );

const formatDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(clean(value));

  if (!match) {
    return '--';
  }

  const [, year, month, day] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);

  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) {
    return '--';
  }

  return `${day}-${month}-${year}`;
};

const formatAmount = (value) => {
  const text = clean(value);

  if (!text) {
    return '--';
  }

  const number = Number(text.replace(/,/g, ''));

  if (!Number.isFinite(number)) {
    return escapeHtml(text);
  }

  return new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
  }).format(number);
};

const unitTypeOf = (project) => clean(project.unitType).toUpperCase();

const isPlot = (project) => unitTypeOf(project) === 'PLOT';
const isFlat = (project) => unitTypeOf(project) === 'FLAT';

const getNewProjects = (cached, activeProjects) => {
  const oldIds = new Set(cached.ids.map(clean));

  return activeProjects
    .filter((project) => !oldIds.has(clean(project.id)))
    .sort((a, b) => parseCreatedAt(b.createdAt) - parseCreatedAt(a.createdAt));
};

const formatLocation = (project) => {
  const parts = [
    clean(project.village),
    clean(project.taluk),
    clean(project.district),
  ].filter(Boolean);
  const division = isFlat(project) ? clean(project.divisionName) : '';
  const label = division
    ? `${division} - ${parts.join(', ')}`
    : parts.join(', ');
  const safeLabel = escapeHtml(label || 'Location');
  const url = clean(project.location);

  return url
    ? `Location: <a href="${escapeHtml(url)}">${safeLabel}</a>`
    : `Location: ${safeLabel}`;
};

const formatAreaTypes = (project) =>
  [project.area1, project.area2, project.area3, project.area4]
    .map(clean)
    .filter(Boolean)
    .map(escapeHtml)
    .join(', ');

const formatBhkTypes = (project) =>
  [project.bhk1, project.bhk2, project.bhk3, project.bhk4]
    .map(clean)
    .filter(Boolean)
    .map((raw) => {
      const separatorIndex = raw.indexOf('_');

      if (separatorIndex === -1) {
        return escapeHtml(raw);
      }

      const type = clean(raw.slice(0, separatorIndex));
      const area = clean(raw.slice(separatorIndex + 1));

      return area
        ? `${escapeHtml(area)} (${escapeHtml(type.toUpperCase())})`
        : escapeHtml(raw);
    })
    .join(', ');

const formatTypes = (project) => {
  if (isPlot(project)) {
    return formatAreaTypes(project) || '--';
  }

  if (isFlat(project)) {
    return formatBhkTypes(project) || '--';
  }

  // Unknown unit types may use either scheme; prefer area values.
  return formatAreaTypes(project) || formatBhkTypes(project) || '--';
};

const composeProjectBlock = (project, index) => {
  const name = escapeHtml(clean(project.schemeName) || 'Untitled');
  const imageUrl = clean(project.schemeImg);
  const id = clean(project.id);

  let block = `\n\n<b>${index}. ${name}</b>`;

  if (imageUrl) {
    block += `\n📷 <a href="${escapeHtml(imageUrl)}">Scheme Image</a>`;
  }

  block += `\n${formatLocation(project)}`;

  if (!isPlot(project) && !isFlat(project)) {
    block += `\nType: ${textOrDash(project.unitType)}`;
  }

  block += `\nPrice (approx.): Rs. ${formatAmount(project.approximatePrice)}`;
  block += `\nTotal Units: ${textOrDash(project.totalUnits)}`;
  block += `\nTypes (sq.ft.): ${formatTypes(project)}`;
  block += `\nScheme: ${textOrDash(project.modeOfProject)}`;
  block += `\nScheme Type: ${textOrDash(project.projectStatus)}`;
  block += `\nCommence (tentative): ${formatDate(project.commenceDate)}`;
  block += `\nLaunch (expected): ${formatDate(project.expectedLaunch)}`;
  block += `\nDuration (months): ${textOrDash(project.projectDuration)}`;
  block += `\n<a href="${escapeHtml(registrationUrlPrefix)}${encodeURIComponent(id)}">Register Your Interest</a>`;

  return block;
};

const composeDigestMessages = (delta) => {
  const groups = [
    { label: 'Plots', items: delta.filter(isPlot) },
    { label: 'Flats', items: delta.filter(isFlat) },
    {
      label: 'Others',
      items: delta.filter((item) => !isPlot(item) && !isFlat(item)),
    },
  ].filter((group) => group.items.length > 0);
  const sections = groups.map((group) => {
    const sectionHeader = `\n\n<b>${group.label} (${group.items.length})</b>`;

    return {
      intro: sectionHeader,
      continuationIntro: sectionHeader,
      blocks: group.items.map((project, index) =>
        composeProjectBlock(project, index + 1),
      ),
    };
  });

  return chunkDigest({
    header: `<b>TNHB Upcoming Projects (${delta.length})</b>`,
    continuationHeader: '<b>TNHB Upcoming Projects (contd.)</b>',
    sections,
  });
};

(async () => {
  if (!TNHB_UPCOMING_PROJECTS_API_URL) {
    console.error('TNHB_UPCOMING_PROJECTS_API_URL is empty!');

    process.exit(1);
  }

  if (!registrationUrlPrefix) {
    console.error('TNHB_INTEREST_REGISTRATION_URL is empty!');

    process.exit(1);
  }

  if (!PROXY_API_URL || !PROXY_API_KEY) {
    console.error('PROXY_API_URL or PROXY_API_KEY is empty!');

    process.exit(1);
  }

  const cached = readProjectsCache();

  let response;
  try {
    response = await fetchWithRetry(
      buildProxiedUrl(
        TNHB_UPCOMING_PROJECTS_API_URL,
        PROXY_API_URL,
        PROXY_API_KEY,
      ),
      { method: 'POST', data: {}, label: 'TNHB projects API' },
    );
  } catch (error) {
    console.error('API failed after 3 attempts.');

    process.exit(1);
  }

  const responseData = response.data;

  if (!responseData || !Array.isArray(responseData.responseObject)) {
    console.error(
      'Unexpected API response shape; expected { responseObject: [] }.',
    );

    process.exit(1);
  }

  const activeProjects = responseData.responseObject.filter(
    (project) => project && clean(project.messageStatus) === 'ACTIVE',
  );
  const newProjects = cached ? getNewProjects(cached, activeProjects) : [];
  const activeIds = activeProjects.map((project) => clean(project.id));
  // GitHub cache keys are immutable, so every save needs a fresh key.
  const cacheKey = `tnhb_projects-${newProjects.length}-${Date.now()}`;

  // First run (no cache): seed the cache file silently, notify nothing.
  if (!cached) {
    writeCache(CACHE_FILE_PATH, { ids: activeIds, snapshot: activeProjects });
    console.info(
      `First run: cached ${activeProjects.length} active project(s). No message sent.`,
    );
    appendGithubOutput([
      'changed=true',
      'notified=false',
      `cache_key=${cacheKey}`,
    ]);

    return;
  }

  const payloadChanged =
    JSON.stringify(cached.snapshot) !== JSON.stringify(activeProjects);
  // Only new ids trigger a digest; payload edits refresh the snapshot without
  // re-sending projects that were already delivered.
  const changed = newProjects.length > 0 || payloadChanged;

  appendGithubOutput([
    `changed=${changed}`,
    'notified=false',
    `cache_key=${cacheKey}`,
  ]);

  if (newProjects.length === 0) {
    if (changed) {
      writeCache(CACHE_FILE_PATH, {
        ids: activeIds,
        snapshot: activeProjects,
      });
    }

    console.info('Response changed but no new project IDs. Nothing to send.');

    return;
  }

  if (!TNHB_TELEGRAM_API_TOKEN || !TNHB_TELEGRAM_CHAT_ID) {
    console.error('Telegram credentials are empty; cannot send digest.');

    process.exit(1);
  }

  const messages = composeDigestMessages(newProjects);
  let failedChunk = 0;

  try {
    for (const [index, message] of messages.entries()) {
      failedChunk = index + 1;
      // eslint-disable-next-line no-await-in-loop
      const sent = await sendMessage(
        message,
        TNHB_TELEGRAM_API_TOKEN,
        TNHB_TELEGRAM_CHAT_ID,
      );

      if (!sent) {
        throw new Error('Telegram API returned ok=false');
      }
    }
  } catch (error) {
    console.error(
      `Failed to send projects digest chunk ${failedChunk}/${messages.length}: ${error.message}`,
    );

    process.exit(1);
  }

  // Advance the cache only after every chunk was delivered, so a failed send
  // is retried on the next run instead of losing the notification.
  writeCache(CACHE_FILE_PATH, { ids: activeIds, snapshot: activeProjects });

  console.info(`Message sent! (${newProjects.length} new project(s).)`);
  appendGithubOutput(['notified=true']);
})();
