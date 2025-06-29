const axios = require('axios');
const cheerio = require('cheerio');
const { parse } = require('date-fns');

require('dotenv').config();

require('../../utils/axios.utils');

const save = process.argv.includes('--save');

const RBI_POLICY_RATES_DATA_SOURCE_URL =
  process.env.RBI_POLICY_RATES_DATA_SOURCE_URL || '';
const RBI_POLICY_RATES_JSON_BLOB = process.env.RBI_POLICY_RATES_JSON_BLOB || '';

async function extractPolicyRates() {
  if (!RBI_POLICY_RATES_DATA_SOURCE_URL) {
    console.error('URL is empty!');
    process.exit(1);
  }

  const data = { lastUpdated: Date.now(), rates: [] };
  const rates = [];

  try {
    const { data: html } = await axios.get(RBI_POLICY_RATES_DATA_SOURCE_URL);
    const $ = cheerio.load(html);
    const table = $(
      '#_com_rbi_policy_rate_archive_RBIPolicyRateArchivePortlet_INSTANCE_uwbl_myContainerSearchContainer table'
    );

    if (!table.length) {
      return data;
    }

    table.find('tr:not(.d-none)').each((index, row) => {
      // Skip header row
      if (index === 0) return;

      const columns = $(row).find('td');
      if (columns.length >= 6) {
        const dateText = sanitizeText($(columns[0]).text());
        const date = parse(dateText, 'MMM dd, yyyy', new Date());

        const rateEntry = {
          effectiveDate: date?.getTime() || 0, // Convert to epoch
          policyRepoRate: parseFloat(sanitizeText($(columns[1]).text())) || 0,
          standingDepositFacilityRate:
            parseFloat(sanitizeText($(columns[2]).text())) || 0,
          marginalStandingFacilityRate:
            parseFloat(sanitizeText($(columns[3]).text())) || 0,
          bankRate: parseFloat(sanitizeText($(columns[4]).text())) || 0,
          fixedReverseRepoRate:
            parseFloat(sanitizeText($(columns[5]).text())) || 0,
        };

        rates.push(rateEntry);
      }
    });
  } catch (error) {
    console.error('Error fetching or processing data:', error);
  } finally {
    return { ...data, rates };
  }
}

async function saveToJsonBlob(data) {
  try {
    if (!RBI_POLICY_RATES_JSON_BLOB) {
      console.error('Skipping save as JSON Blob is empty.');
      return;
    }

    const response = await axios.put(
      `https://jsonblob.com/api/jsonBlob/${RBI_POLICY_RATES_JSON_BLOB}`,
      data,
      { headers: { 'Content-Type': 'application/json' } }
    );
    console.log(
      `POST request to JSON Blob sent and received response status code ${response.status}.`
    );
    return true;
  } catch (error) {
    console.error('Error saving to JSON Blob:', error);
    return false;
  }
}

function sanitizeText(text) {
  return text
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const data = await extractPolicyRates();

  if (data.rates.length === 0) {
    console.error('No data found');
    return;
  }

  console.log(JSON.stringify(data, null, 2));

  if (save) {
    await saveToJsonBlob(data);
  }
}

main();
