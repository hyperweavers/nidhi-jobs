const axios = require('axios');
const cheerio = require('cheerio');
const { parse, getTime } = require('date-fns');

require('dotenv').config();

const save = process.argv.includes('--save');
const IBJA_GOLD_RATES_JSON_BLOB = process.env.IBJA_GOLD_RATES_JSON_BLOB || '';

async function scrapeGoldRates() {
  try {
    const { data: html } = await axios.get('https://ibjarates.com');
    const $ = cheerio.load(html);

    const ratesTables = $('.rates-tbl');

    // Process first node
    const lastUpdatedText = ratesTables
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    const lastUpdatedMatch = lastUpdatedText.match(/Last updated time : (.+)/);
    const lastUpdated = lastUpdatedMatch
      ? getTime(parse(lastUpdatedMatch[1], 'MMM dd yyyy hh:mma', new Date()))
      : null;

    if (!lastUpdated) {
      console.log('Last updated time not found');
      return null;
    }

    const rates = [];

    // Process second node
    const secondTable = ratesTables.eq(1);
    if (secondTable.length) {
      const dateStr = secondTable.find('#txtRatedate').val();
      const date = getTime(parse(dateStr, 'dd/MM/yyyy', new Date()));

      secondTable.find('tbody tr').each((_, row) => {
        const columns = $(row).find('td');
        if (columns.length >= 4) {
          rates.push({
            date,
            metal: $(columns[0]).text().trim(),
            purity: parseFloat($(columns[1]).text()),
            rate: {
              forenoon: parseFloat($(columns[2]).text()) || null,
              afternoon: parseFloat($(columns[3]).text()) || null,
            },
          });
        }
      });
    }

    // Process third node
    const thirdTable = ratesTables.eq(2);
    if (thirdTable.length) {
      thirdTable.find('tbody tr').each((_, row) => {
        const columns = $(row).find('td');
        if (columns.length >= 4) {
          rates.push({
            date: lastUpdated,
            metal: $(columns[0]).text().trim(),
            purity: parseFloat($(columns[1]).text()),
            rate: {
              forenoon: parseFloat($(columns[2]).text()) || null,
              afternoon: parseFloat($(columns[3]).text()) || null,
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
