const axios = require('axios');
const cheerio = require('cheerio');
const { parse } = require('date-fns');

require('dotenv').config();

const save = process.argv.includes('--save');
const RBI_POLICY_RATES_JSON_BLOB = process.env.RBI_POLICY_RATES_JSON_BLOB || '';

async function extractPolicyRates() {
  try {
    const data = { lastUpdated: Date.now(), rbiPolicyRates: [] };

    const { data: html } = await axios.get(
      'https://website.rbi.org.in/web/rbi/policy-rate-archive'
    );
    const $ = cheerio.load(html);
    const table = $(
      '#_com_rbi_policy_rate_archive_RBIPolicyRateArchivePortlet_INSTANCE_uwbl_myContainerSearchContainer table'
    );

    if (!table.length) {
      return data;
    }

    const rbiPolicyRates = [];

    table.find('tr:not(.d-none)').each((index, row) => {
      // Skip header row
      if (index === 0) return;

      const columns = $(row).find('td');
      if (columns.length >= 6) {
        const dateText = $(columns[0]).text().trim();
        const date = parse(dateText, 'MMM dd, yyyy', new Date());

        const rateEntry = {
          effectiveDate: date.getTime(), // Convert to epoch
          policyRepoRate: parseFloat($(columns[1]).text()) || null,
          standingDepositFacilityRate: parseFloat($(columns[2]).text()) || null,
          marginalStandingFacilityRate:
            parseFloat($(columns[3]).text()) || null,
          bankRate: parseFloat($(columns[4]).text()) || null,
          fixedReverseRepoRate: parseFloat($(columns[5]).text()) || null,
        };

        rbiPolicyRates.push(rateEntry);
      }
    });

    return { ...data, rbiPolicyRates };
  } catch (error) {
    console.error('Error fetching or processing data:', error);
    return { rbiPolicyRates: [] };
  }
}

async function saveToJsonBlob(data) {
  try {
    if (!RBI_POLICY_RATES_JSON_BLOB) {
      console.log('Skipping save as JSON Blob is empty.');
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

async function main() {
  const data = await extractPolicyRates();

  if (data.rbiPolicyRates.length === 0) {
    console.log('No data found');
    return;
  }

  console.log(JSON.stringify(data, null, 2));

  if (save) {
    await saveToJsonBlob(data);
  }
}

main();
