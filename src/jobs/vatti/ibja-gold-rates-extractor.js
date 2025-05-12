const axios = require('axios');
const cheerio = require('cheerio');
const { parse, getTime } = require('date-fns');
const { fromZonedTime } = require('date-fns-tz');

require('dotenv').config();

require('../../utils/axios.utils');

const save = process.argv.includes('--save');

const IBJA_GOLD_RATES_DATA_SOURCE_URL =
  process.env.IBJA_GOLD_RATES_DATA_SOURCE_URL || '';
const IBJA_GOLD_RATES_JSON_BLOB = process.env.IBJA_GOLD_RATES_JSON_BLOB || '';

async function scrapeGoldRates() {
  if (!IBJA_GOLD_RATES_DATA_SOURCE_URL) {
    console.error('URL is empty!');
    process.exit(1);
  }

  try {
    const { data: html } = await axios.get(IBJA_GOLD_RATES_DATA_SOURCE_URL);
    const $ = cheerio.load(html);

    const ratesTables = $('.rates-tbl');

    // Process first node (div)
    const lastUpdatedText = sanitizeText(ratesTables.first().text());
    const lastUpdatedMatch = lastUpdatedText.match(/Last updated time : (.+)/);

    // Parse date in IST timezone
    const lastUpdated = lastUpdatedMatch
      ? getTime(
          fromZonedTime(
            parse(lastUpdatedMatch[1], 'MMM dd yyyy hh:mma', new Date()),
            'Asia/Kolkata'
          )
        )
      : 0;

    if (!lastUpdated) {
      console.log('Last updated time not found');
      return null;
    }

    const rates = [];

    // Process second node (table)
    const secondTable = ratesTables.eq(1);
    if (secondTable.length) {
      const dateStr = secondTable.find('#txtRatedate').val();
      // Parse date in IST timezone
      const date =
        getTime(
          fromZonedTime(
            parse(dateStr, 'dd/MM/yyyy', new Date()),
            'Asia/Kolkata'
          )
        ) || 0;

      secondTable.find('tbody tr').each((_, row) => {
        const columns = $(row).find('td');
        if (columns.length >= 4) {
          rates.push({
            date,
            metal: sanitizeText($(columns[0]).text()),
            purity: parseFloat(sanitizeText($(columns[1]).text())),
            rate: {
              forenoon: parseFloat(sanitizeText($(columns[2]).text())) || 0,
              afternoon: parseFloat(sanitizeText($(columns[3]).text())) || 0,
            },
          });
        }
      });
    }

    // Process third node (table)
    const thirdTable = ratesTables.eq(2);
    if (thirdTable.length) {
      thirdTable.find('tbody tr').each((_, row) => {
        const columns = $(row).find('td');
        if (columns.length >= 4) {
          rates.push({
            date: lastUpdated,
            metal: sanitizeText($(columns[0]).text()),
            purity: parseFloat(sanitizeText($(columns[1]).text())),
            rate: {
              forenoon: parseFloat(sanitizeText($(columns[2]).text())) || 0,
              afternoon: parseFloat(sanitizeText($(columns[3]).text())) || 0,
            },
          });
        }
      });
    }

    return {
      lastUpdated,
      rates,
    };
  } catch (error) {
    console.error('Error scraping gold rates:', error);
    return null;
  }
}

function sanitizeText(text) {
  return text
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const result = await scrapeGoldRates();

  if (!result || result.rates.length === 0) {
    console.log('No data found');
    return;
  }

  console.log(JSON.stringify(result, null, 2));

  if (save) {
    if (!IBJA_GOLD_RATES_JSON_BLOB) {
      console.error('Skipping save as JSON Blob is empty.');
      return;
    }

    try {
      const response = await axios.put(
        `https://jsonblob.com/api/jsonBlob/${IBJA_GOLD_RATES_JSON_BLOB}`,
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
    } catch (error) {
      console.error('Error saving to JSONBlob:', error);
    }
  }
}

main().catch(console.error);
