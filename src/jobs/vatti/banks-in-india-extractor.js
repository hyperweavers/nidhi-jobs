const axios = require('axios');
const cheerio = require('cheerio');

require('dotenv').config();

const save = process.argv.includes('--save');
const BANKS_IN_INDIA_JSON_BLOB = process.env.BANKS_IN_INDIA_JSON_BLOB || '';

async function scrapeBanks() {
  try {
    const { data: html } = await axios.get(
      'https://website.rbi.org.in/web/rbi/important-websites/websites-of-banks-in-india'
    );
    const $ = cheerio.load(html);

    const result = {
      lastUpdated: Math.floor(Date.now() / 1000),
      banks: [],
    };

    $('#Accordionheading').each((_, element) => {
      const type = $(element).text().replaceAll('+', '').trim();
      const list = [];

      const sibling = $(element).next();

      sibling.find('a').each((_, bankElement) => {
        list.push({
          name: $(bankElement).text().replaceAll('%', '').trim(),
          website: $(bankElement).attr('href'),
        });
      });

      result.banks.push({
        type,
        list,
      });
    });

    // Validate that all bank type arrays have items
    const hasEmptyArray = result.banks.some(
      (bankType) => bankType.list.length === 0
    );

    if (hasEmptyArray) {
      console.log('One of the bank type array is empty');
      return;
    }

    console.log(JSON.stringify(result, null, 2));

    if (save) {
      if (!BANKS_IN_INDIA_JSON_BLOB) {
        console.log('Skipping save as JSON Blob is empty.');
        return;
      }

      const response = await axios.put(
        `https://jsonblob.com/api/jsonBlob/${BANKS_IN_INDIA_JSON_BLOB}`,
        result,
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
      console.log(
        `POST request to JSON Blob sent and received response status code ${response.status}.`
      );
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

scrapeBanks();
