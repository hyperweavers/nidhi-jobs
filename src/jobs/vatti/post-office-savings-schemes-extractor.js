/**
 * This script will:
 *   1. Fetch the HTML from the provided URL.
 *   2. Parse and locate the table that has caption "Interest rates (New)".
 *   3. Drop the "Sl.No." column.
 *   4. Extract the "Rate of interest w.e.f <FROM> to <TO>" heading from the table
 *      and parse those date strings into epoch timestamps.
 *   5. For each data row, extract:
 *       - title (string)
 *       - interestRate (number)
 *       - compoundingFrequency (string)
 *       - compounding (boolean)
 *       - tenure (number)
 *   6. Construct the JSON according to the specification.
 */

const axios = require('axios');
const cheerio = require('cheerio');

require('dotenv').config();

const save = process.argv.includes('--save');
const POST_OFFICE_SAVINGS_SCHEMES_JSON_BLOB =
  process.env.POST_OFFICE_SAVINGS_SCHEMES_JSON_BLOB || '';

const url =
  'https://www.indiapost.gov.in/Financial/Pages/Content/Post-Office-Saving-Schemes.aspx';

async function extractInterestRates() {
  try {
    const { data: html } = await axios.get(url);
    const $ = cheerio.load(html);
    const targetCaptionText = 'Interest rates (New)';

    let table;

    $('.annual_property_list table.static_table caption').each((_, elem) => {
      if (
        $(elem)
          .text()
          .replace(/[^\x00-\x7F]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
          .includes(targetCaptionText.toLowerCase())
      ) {
        // The parent of the caption should be the table element
        table = $(elem).closest('table');
      }
    });

    if (!table || table.length === 0) {
      throw new Error(
        `Could not find table with caption: ${targetCaptionText}`
      );
    }

    const headers = [];
    table.find('tr th').each((_index, elem) => {
      headers.push(
        $(elem)
          .text()
          .replace(/[^\x00-\x7F]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      );
    });

    const instrumentsIndex = headers.findIndex((h) =>
      h.toLowerCase().includes('instruments')
    );
    const interestIndex = headers.findIndex((h) =>
      h.toLowerCase().includes('rate of interest')
    );
    const compoundingIndex = headers.findIndex((h) =>
      h.toLowerCase().includes('compounding frequency')
    );

    if (instrumentsIndex === -1) {
      throw new Error("Could not find a header starting with 'Instruments'.");
    }

    if (interestIndex === -1) {
      throw new Error(
        "Could not find a header starting with 'Rate of interest'."
      );
    }

    if (compoundingIndex === -1) {
      throw new Error(
        "Could not find a header starting with 'Compounding frequency'."
      );
    }

    const interestHeading = headers[interestIndex];
    // Extract the FROM and TO portions
    // Typical format: "Rate of interest w.e.f 01.01.2023 to 31.03.2023"
    // We'll do a regex to capture dd.mm.yyyy groups.
    // If it doesn't match, fallback to 0 epoch just to be safe.
    let fromEpoch = 0;
    let toEpoch = 0;

    const dateRegex =
      /w\.?e\.?f\.?\s+(\d{2}\.\d{2}\.\d{4})\s+to\s+(\d{2}\.\d{2}\.\d{4})/i;
    const match = interestHeading.match(dateRegex);
    if (match) {
      const [, fromStr, toStr] = match;
      fromEpoch = parseDateToEpoch(fromStr);
      toEpoch = parseDateToEpoch(toStr);
    }

    const result = {
      lastUpdated: Date.now(),
      effective: {
        from: fromEpoch,
        to: toEpoch,
      },
      schemes: [],
    };

    table.find('tbody tr').each((_, row) => {
      const cells = $(row).children('td');

      // If row doesn't have enough cells, skip
      if (cells.length < 4) return;

      let instrumentsText =
        instrumentsIndex >= 0
          ? $(cells.get(instrumentsIndex))
              .text()
              .replace(/[^\x00-\x7F]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
          : '';
      let interestText =
        interestIndex >= 0
          ? $(cells.get(interestIndex))
              .text()
              .replace(/[^\x00-\x7F]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
          : '';
      let compoundingText =
        compoundingIndex >= 0
          ? $(cells.get(compoundingIndex))
              .text()
              .replace(/[^\x00-\x7F]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
          : '';

      const { title, tenure } = extractTitleAndTenure(instrumentsText);

      const interestRate = parseInterestRate(interestText);

      const { frequency, compounding } = parseCompounding(compoundingText);

      const rowObject = {
        title: title,
        interestRate: interestRate,
        compoundingFrequency: frequency,
        compounding: compounding,
        tenure: tenure,
      };

      result.schemes.push(rowObject);
    });

    if (
      result.effective.from &&
      result.effective.to &&
      result.schemes.length === 13
    ) {
      console.log(JSON.stringify(result, null, 2));

      if (save) {
        if (!POST_OFFICE_SAVINGS_SCHEMES_JSON_BLOB) {
          console.log('Skipping save as JSON Blob is empty.');
          return;
        }

        const res = await axios.put(
          `https://jsonblob.com/api/jsonBlob/${POST_OFFICE_SAVINGS_SCHEMES_JSON_BLOB}`,
          result,
          { headers: { 'Content-Type': 'application/json' } }
        );
        console.log(
          `POST request sent with response status code ${res.status}.`
        );
      }
    } else {
      console.error('Invalid output:', JSON.stringify(result, null, 2));
    }
  } catch (err) {
    console.error('Error extracting interest rates:', err.message);
  }
}

/**
 * Converts from dd.mm.yyyy to epoch (milliseconds).
 */
function parseDateToEpoch(ddmmyyyy) {
  const [day, month, year] = ddmmyyyy.split('.');
  // Construct ISO string: yyyy-mm-dd
  const isoString = `${year}-${month}-${day}`;
  return new Date(isoString).getTime();
}

/**
 * Extracts the interest rate as a number from possible formats like:
 *   "7.4" or "7.4 (quarterly compounding)"
 */
function parseInterestRate(interestCellText) {
  // The basic idea is to extract the first floating number we see.
  const match = interestCellText.match(/\d+(\.\d+)?/);
  if (!match) {
    return 0; // fallback
  }
  return parseFloat(match[0]);
}

/**
 * Determines the compounding frequency and whether compounding is true/false
 * based on strings like:
 *   "Quarterly"
 *   "Quarterly and Paid"
 *   "Annually"
 *   "Annually and Paid", etc.
 */
function parseCompounding(compoundingCellText) {
  // If there's an "and Paid",
  // then compounding = false, else compounding = true
  let compounding = true;
  let frequency = compoundingCellText;

  if (compoundingCellText.toLowerCase().includes('and paid')) {
    compounding = false;
    frequency = frequency.replace(/and paid/i, '').trim();
  }

  return {
    frequency: frequency.trim(),
    compounding: compounding,
  };
}

/**
 * Determines the title and tenure from the Instruments column.
 * According to the instructions:
 *   1) If row ends with "Time Deposit" => title = "Time Deposit",
 *      tenure is the number extracted from "<TENURE> Year Time Deposit".
 *   2) If row ends with "Recurring Deposit Scheme" => title = "Recurring Deposit",
 *      tenure = item from "<TENURE> Year Recurring Deposit Scheme".
 *   3) If instruments is any of the following, set tenure=0:
 *       "Post Office Savings Account", "Senior Citizen Savings Scheme",
 *       "Monthly Income Account", "National Savings Certificate...",
 *       "Public Provident Fund Scheme", "Kisan Vikas Patra",
 *       "Mahila Samman Savings Certificate", "Sukanya Samriddhi Account Scheme"
 */
function extractTitleAndTenure(instrumentsText) {
  const normalized = instrumentsText.trim().toLowerCase();
  if (normalized.includes('time deposit')) {
    // e.g. "1 Year Time Deposit", "2 Year Time Deposit", "5 Year Time Deposit"
    // Try to parse the leading number
    const match = instrumentsText.match(/(\d+)\s*year\s*time deposit/i);

    if (match) {
      const tenure = parseInt(match[1], 10);
      return {
        title: 'Time Deposit',
        tenure: tenure,
      };
    }
    // fallback
    return {
      title: 'Time Deposit',
      tenure: 0,
    };
  }

  // Check if ends with "recurring deposit scheme"
  if (normalized.includes('recurring deposit scheme')) {
    // e.g. "5 Year Recurring Deposit Scheme"
    const match = instrumentsText.match(
      /(\d+)\s*year\s*recurring deposit scheme/i
    );
    if (match) {
      const tenure = parseInt(match[1], 10);
      return {
        title: 'Recurring Deposit',
        tenure: tenure,
      };
    }
    // fallback
    return {
      title: 'Recurring Deposit',
      tenure: 0,
    };
  }

  if (normalized.includes('national savings certificate')) {
    return {
      title: instrumentsText.trim(),
      tenure: 5,
    };
  }

  if (normalized.includes('mahila samman savings certificate')) {
    return {
      title: instrumentsText.trim(),
      tenure: 2,
    };
  }

  if (normalized.includes('sukanya samriddhi account scheme')) {
    return {
      title: instrumentsText.replace('scheme', '').trim(),
      tenure: 21,
    };
  }

  if (normalized.includes('public provident fund scheme')) {
    return {
      title: instrumentsText.replace('scheme', '').trim(),
      tenure: 15,
    };
  }

  if (normalized.includes('senior citizen savings scheme')) {
    return {
      title: instrumentsText.trim(),
      tenure: 5,
    };
  }

  if (normalized.includes('monthly income account')) {
    return {
      title: instrumentsText.trim(),
      tenure: 5,
    };
  }

  if (normalized.includes('post office savings account')) {
    return {
      title: instrumentsText.trim(),
      tenure: 0,
    };
  }

  // Default fallback
  return {
    title: instrumentsText.trim(),
    tenure: 0,
  };
}

extractInterestRates();
