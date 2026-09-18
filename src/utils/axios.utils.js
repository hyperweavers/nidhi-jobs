const axios = require('axios');
const axiosRetry = require('axios-retry').default;

const DEFAULT_HTTP_TIMEOUT_MS = 10000;
const TNHB_HTTP_TIMEOUT_MS = 30000;

// Default max timeout for all HTTP calls (10s). Override per-request
// where a longer timeout is needed (e.g. TNHB API uses 30s).
axios.defaults.timeout = DEFAULT_HTTP_TIMEOUT_MS;

axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => {
      console.log(`Retry attempt: ${retryCount}`);
      return retryCount * 2000;
  },
  retryCondition: (error) => {
      // Timeout / network errors have no response; retry them.
      if (!error.response) {
        return true;
      }

      switch (error.response.status) {
        case 408: // Request Timeout
        case 500: // Internal Server Error
        case 502: // Bad Gateway
        case 503: // Service Unavailable
        case 504: // Gateway Timeout
          return true;

        default:
          return false;
      };
  },
});

module.exports = { DEFAULT_HTTP_TIMEOUT_MS, TNHB_HTTP_TIMEOUT_MS };
