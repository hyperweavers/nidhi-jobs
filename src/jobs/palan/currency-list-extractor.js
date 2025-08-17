const axios = require('axios');

require('dotenv').config();

require('../../utils/axios.utils');

const save = process.argv.includes('--save');

const CURRENCY_LIST_DATA_SOURCE_URL =
  process.env.CURRENCY_LIST_DATA_SOURCE_URL || '';
const CURRENCY_LIST_JSON_BLOB = process.env.CURRENCY_LIST_JSON_BLOB || '';

async function scrapeCurrencyList() {
  if (!CURRENCY_LIST_DATA_SOURCE_URL) {
    console.error('URL is empty!');
    process.exit(1);
  }

  try {
    const { data } = await axios.get(CURRENCY_LIST_DATA_SOURCE_URL);

    const currencies = data?.searchresult || [];

    if (currencies.length <= 0) {
      console.error('Currency list is empty!');
      return;
    }

    console.info(JSON.stringify(currencies, null, 2));

    if (save) {
      if (!CURRENCY_LIST_JSON_BLOB) {
        console.error('Skipping save as JSON Blob is empty.');
        return;
      }

      const response = await axios.put(
        `https://jsonblob.com/api/jsonBlob/${CURRENCY_LIST_JSON_BLOB}`,
        currencies,
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
      console.info(
        `POST request to JSON Blob sent and received response status code ${response.status}.`
      );
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

scrapeCurrencyList();
