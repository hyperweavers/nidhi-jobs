const axios = require('axios');
const cheerio = require('cheerio');
const { parse } = require('date-fns');

async function extractPolicyRates() {
  try {
    const response = await axios.get(
      'https://website.rbi.org.in/web/rbi/policy-rate-archive'
    );
    const $ = cheerio.load(response.data);
    const table = $(
      'table[data-searchcontainerid="_com_rbi_policy_rate_archive_RBIPolicyRateArchivePortlet_INSTANCE_uwbl_myContainer"]'
    );

    if (!table.length) {
      return { rbiPolicyRates: [] };
    }

    const rbiPolicyRates = [];

    table.find('tr').each((index, row) => {
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

    return { rbiPolicyRates };
  } catch (error) {
    console.error('Error fetching or processing data:', error);
    return { rbiPolicyRates: [] };
  }
}

async function saveToJsonBlob(data) {
  try {
    const jsonBlobId = process.env.RBI_POLICY_RATES_JSON_BLOB || '';
    const response = await axios.post(
      `https://jsonblob.com/api/jsonBlob/${jsonBlobId}`,
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

  const shouldSave = process.argv.includes('save');
  if (shouldSave) {
    await saveToJsonBlob(data);
  }
}

main();
