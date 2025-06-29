const axios = require('axios');
const cheerio = require('cheerio');
const { parse, getTime } = require('date-fns');
const { fromZonedTime } = require('date-fns-tz');

require('dotenv').config();
require('../../utils/axios.utils');

const save = process.argv.includes('--save');

const IBJA_GOLD_RATES_DATA_SOURCE_URL = process.env.IBJA_GOLD_RATES_DATA_SOURCE_URL || '';
const IBJA_GOLD_RATES_JSON_BLOB = process.env.IBJA_GOLD_RATES_JSON_BLOB || '';

function sanitizeText(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function scrapeGoldRates() {
  if (!IBJA_GOLD_RATES_DATA_SOURCE_URL) {
    console.error('URL is empty!');
    process.exit(1);
  }

  try {
    const { data: html } = await axios.get(IBJA_GOLD_RATES_DATA_SOURCE_URL);
    const $ = cheerio.load(html);

    // Extract the tab-content node and its children
    const tabContent = $('.tab-content');
    const tabAm = tabContent.find('#tab-am');
    const tabPm = tabContent.find('#tab-pm');
    const amRows = tabAm.find('tbody tr');
    const pmRows = tabPm.find('tbody tr');

    // Build a map for PM rates: { rowIdx: { dataLabel: value } }
    const pmRatesMap = [];
    if (pmRows?.length > 0) {
      pmRows.each((_, row) => {
        const rowMap = {};
        $(row).find('td').each((_, td) => {
          const dataLabel = $(td).attr('data-label');
          if (dataLabel && dataLabel !== 'PM') {
            const val = sanitizeText($(td).text());
            rowMap[dataLabel] = val ? parseFloat(val.replace(/,/g, '')) : null;
          }
        });
        pmRatesMap.push(rowMap);
      });
    }

    let lastUpdated = 0;
    const rates = [];

    amRows.each((rowIdx, row) => {
      let date = 0;

      $(row).find('td').each((colIdx, td) => {
        const dataLabel = $(td).attr('data-label');
        if (dataLabel === 'AM') { // First, find the date from the AM column
          const dateText = sanitizeText($(td).text().replace(/<[^>]+>/g, ''));
          if (dateText) {
            date = getTime(
              fromZonedTime(
                parse(dateText, 'dd/MM/yyyy', new Date()),
                'Asia/Kolkata'
              )
            );
            if (rowIdx === 0) {
              lastUpdated = date;
            }
          }
        } else if (dataLabel) { // Now, for each column except the first (AM), extract metal, purity, rates
          // dataLabel format: "Metal Purity" (e.g., "Gold 995")
          let metal = null, purity = null, quantity = null;
          const match = dataLabel.match(/^(.*?)\s+(\d+(?:\.\d+)?)$/);
          if (match) {
            metal = match[1];
            purity = parseFloat(match[2]);
            quantity = (metal && metal.trim().toLowerCase() === 'gold') ? 10 : (metal && metal.trim().toLowerCase() === 'silver') ? 1000 : null;
          }
          const amValRaw = sanitizeText($(td).text());
          const amVal = amValRaw ? parseFloat(amValRaw.replace(/,/g, '')) : null;
          // Find the corresponding PM value from pmRatesMap
          let pmVal = null;
          if (pmRatesMap[rowIdx] && dataLabel in pmRatesMap[rowIdx]) {
            pmVal = pmRatesMap[rowIdx][dataLabel];
          }
          rates.push({
            date,
            metal,
            purity,
            quantity,
            rate: {
              forenoon: amVal,
              afternoon: pmVal,
            },
          });
        } else {
          console.warn(`Data label not found for column ${colIdx}`);
        }
      });
    });

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
  if (!result || !Array.isArray(result.rates) || result.rates.length === 0) {
    console.error('No data found');
    return;
  }

  console.info(JSON.stringify(result, null, 2));

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
      console.info(
        `POST request to JSON Blob sent and received response status code ${response.status}.`
      );
    } catch (error) {
      console.error('Error saving to JSONBlob:', error);
    }
  }
}

main().catch(console.error);
