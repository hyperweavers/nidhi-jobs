const axios = require('axios');
const cheerio = require('cheerio');

require('dotenv').config();

const save = process.argv.includes('--save');

const POST_OFFICE_SAVINGS_SCHEMES_DATA_SOURCE_URL =
  process.env.POST_OFFICE_SAVINGS_SCHEMES_DATA_SOURCE_URL || '';
const POST_OFFICE_SAVINGS_SCHEMES_JSON_BLOB =
  process.env.POST_OFFICE_SAVINGS_SCHEMES_JSON_BLOB || '';

async function extractInterestRates() {
  if (!POST_OFFICE_SAVINGS_SCHEMES_DATA_SOURCE_URL) {
    console.error('URL is empty!');
    process.exit(1);
  }

  try {
    const { data: html } = await axios.get(
      POST_OFFICE_SAVINGS_SCHEMES_DATA_SOURCE_URL
    );
    const $ = cheerio.load(html);

    const currentRates = await extractCurrentInterestRates($);
    const historicRates = extractHistoricInterestRates($);

    const result = {
      ...currentRates,
      schemes: currentRates.schemes.map((scheme) => ({
        ...scheme,
        historicInterestRates: scheme.shortName.startsWith('TD-')
          ? (historicRates['TD'] || []).map((historicRate) => ({
              ...historicRate,
              interestRate:
                historicRate.interestRate.filter(
                  (historicInterestRate) =>
                    scheme.shortName === `TD-${historicInterestRate.tenure}Y`
                )[0]?.interestRate || 0,
            }))
          : historicRates[scheme.shortName] || [],
      })),
    };

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
      console.log(`POST request sent with response status code ${res.status}.`);
    }
  } catch (err) {
    console.error('Error extracting interest rates:', err.message);
  }
}

async function extractCurrentInterestRates($) {
  const targetCaptionText = 'Interest rates (New)';
  let table;

  $('.annual_property_list table.static_table caption').each((_, elem) => {
    if (
      normalizeText(sanitizeText($(elem).text())).includes(
        normalizeText(targetCaptionText)
      )
    ) {
      table = $(elem).closest('table');
    }
  });

  if (!table || table.length === 0) {
    throw new Error(`Could not find table with caption: ${targetCaptionText}`);
  }

  const headers = [];
  table.find('tr th').each((_index, elem) => {
    headers.push(sanitizeText($(elem).text()));
  });

  const instrumentsIndex = headers.findIndex((h) =>
    normalizeText(h).includes('instruments')
  );
  const interestIndex = headers.findIndex((h) =>
    normalizeText(h).includes('rate of interest')
  );
  const compoundingIndex = headers.findIndex((h) =>
    normalizeText(h).includes('compounding frequency')
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

    if (cells.length < 4) return;

    let instrumentsText =
      instrumentsIndex >= 0
        ? sanitizeText($(cells.get(instrumentsIndex)).text())
        : '';
    let interestText =
      interestIndex >= 0
        ? sanitizeText($(cells.get(interestIndex)).text())
        : '';
    let compoundingText =
      compoundingIndex >= 0
        ? sanitizeText($(cells.get(compoundingIndex)).text())
        : '';

    const { name, shortName, recurring, tenure, maturity } =
      extractTitleAndTenure(instrumentsText);

    const { interestRate, maturesIn } = parseInterestRate(interestText);

    let { frequency, payout } = parseCompounding(compoundingText);
    if (shortName === 'SB') {
      payout = true;
      frequency = 'Annually';
    }

    const frequencyPerYear = compoundingFrequencyStringToValue(frequency);

    let effectiveYield = interestRate;
    if (payout) {
      effectiveYield =
        (Math.pow(
          1 + interestRate / 100 / (frequencyPerYear * tenure),
          frequencyPerYear * tenure
        ) -
          1) *
        100;
      effectiveYield =
        Math.round((effectiveYield + Number.EPSILON) * 100) / 100;
    }
    effectiveYield = effectiveYield || interestRate;

    const rowObject = {
      name,
      shortName,
      interestRate,
      effectiveYield,
      depositTenure: recurring ? tenure : 0,
      maturityTenure: maturity || maturesIn,
      compounding: {
        payout,
        frequency,
        frequencyPerYear,
      },
    };

    result.schemes.push(rowObject);
  });

  if (
    result.effective.from &&
    result.effective.to &&
    result.schemes.length === 13
  ) {
    return result;
  } else {
    throw new Error('Invalid output');
  }
}

function extractHistoricInterestRates($) {
  const historicRates = {};
  const $historicDataDiv = $('#tab6');
  $historicDataDiv.find('p:nth-of-type(1), h4, style, br').remove();

  if (!$historicDataDiv || $historicDataDiv.length === 0) {
    throw new Error('Could not find the historic interest rates div.');
  }

  $historicDataDiv.find('p + table').each((index, table) => {
    let schemeName = sanitizeText(
      $historicDataDiv.find(`p:nth-of-type(${index + 1})`).text()
    )
      .replace('Name of Scheme:', '')
      .trim();

    // Skip NSS and NSC IX Issue schemes as it is discontinued
    if (
      !schemeName.startsWith('NSS') &&
      !schemeName.startsWith('NSC IX Issue')
    ) {
      const rates = [];
      $(table)
        .find('tbody tr:not(:empty)')
        .each((i, row) => {
          const cells = $(row).children('td');
          // Skip header row
          if (i > 0) {
            let from = parseDateToEpoch(sanitizeText($(cells[0]).text()));
            let to = parseDateToEpoch(sanitizeText($(cells[1]).text()));

            let interestRate = parseFloat(sanitizeText($(cells[2]).text()));

            let limit;
            if (schemeName === 'RD') {
              interestRate = parseFloat(
                sanitizeText($(cells[2]).text()).match(/\d+(\.\d+)?/)[0]
              );
            } else if (schemeName === 'TD') {
              const headerRow = $(table).find('tbody tr:first-child');
              const headers = $(headerRow).children('th');
              interestRate = extractTdRates($, headers, cells);
            } else if (schemeName === 'PPF') {
              let dateRange = sanitizeText($(cells[0]).text());
              dateRange = dateRange.match(/\d+.\d+.\d+/gi);
              from = parseDateToEpoch(dateRange[0]);
              to = parseDateToEpoch(dateRange[1]);
              interestRate = parseFloat(sanitizeText($(cells[1]).text()));
              limit = parseInt(sanitizeText($(cells[2]).text()));
            } else if (schemeName === 'KVP') {
              let maturity = sanitizeText($(cells[2]).text());
              maturity = maturity
                .match(/\d+\sYear(s*\s\d+\sMonths*)?/gi)[0]
                .replaceAll(/(\s*[a-z]+\s*)/gi, ',')
                .trim()
                .slice(0, -1)
                .trim();
              maturity = maturity.split(',');
              maturity =
                parseInt(maturity[0]) * 12 + (parseInt(maturity[1]) || 0);
              interestRate = getInterestRateFromMaturity(maturity);
              interestRate =
                Math.round((interestRate + Number.EPSILON) * 10) / 10;
            } else if (schemeName.startsWith('NSC VIII Issue')) {
              interestRate = parseFloat(sanitizeText($(cells[3]).text()));
            }

            rates.push({ from, to, interestRate, limit: limit || undefined });
          }
        });

      if (schemeName.startsWith('NSC VIII Issue')) {
        schemeName = 'NSC';
        historicRates[schemeName] = historicRates[schemeName]
          ? historicRates[schemeName].concat(rates)
          : rates;
      } else {
        historicRates[schemeName] = rates;
      }
    }
  });

  return historicRates;
}

function extractTdRates($, headers, cells) {
  const rates = [];

  for (let i = 2; i < cells.length; i++) {
    const tenure = parseInt(
      sanitizeText($(headers[i]).closest('th').text()).match(/\d+/)[0]
    );
    rates.push({
      tenure,
      interestRate: parseFloat(sanitizeText($(cells[i]).text())),
    });
  }
  return rates;
}

function getInterestRateFromMaturity(tenure) {
  // Calculate the total amount from the principal and interest earned
  const principal = 10000;
  const maturity = 2 * principal;
  const frequency = 1;
  tenure = tenure / 12;

  // Calculate the interest rate using the rearranged compound interest formula
  const rate =
    frequency * (Math.pow(maturity / principal, 1 / (frequency * tenure)) - 1);

  // Convert the rate to a percentage
  const percentageRate = rate * 100;

  return percentageRate;
}

function sanitizeText(text) {
  return text
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(text) {
  return text.toLowerCase();
}

function parseDateToEpoch(date) {
  const [day, month, year] = date.split(/[-.]/);
  const isoString = `${year}-${month}-${day}`;
  return new Date(isoString)?.getTime() || 0;
}

function parseInterestRate(interestCellText) {
  const matchInterestRate = interestCellText.match(/\d+(\.\d+)?/);
  const matchTenure = interestCellText.match(
    /\d+\.\d+\s*\(will\s*mature\s*in\s*(\d+)\s*months\)/i
  );

  return {
    interestRate: matchInterestRate ? parseFloat(matchInterestRate[0], 10) : 0,
    maturesIn: matchTenure
      ? Math.round((parseInt(matchTenure[1], 10) / 12 + Number.EPSILON) * 100) /
        100
      : 0,
  };
}

function parseCompounding(compoundingCellText) {
  let payout = true;
  let frequency = compoundingCellText;

  if (normalizeText(compoundingCellText).includes('and paid')) {
    payout = false;
    frequency = frequency.replace(/and paid/i, '').trim();
  }

  return {
    payout,
    frequency,
  };
}

function extractTitleAndTenure(instrumentsText) {
  const normalized = normalizeText(instrumentsText);
  if (normalized.includes('time deposit')) {
    const match = instrumentsText.match(/(\d+)\s*year\s*time deposit/i);

    if (match) {
      const tenure = parseInt(match[1], 10);
      return {
        name: 'Time Deposit',
        shortName: `TD-${tenure}Y`,
        recurring: false,
        tenure: tenure,
        maturity: tenure,
      };
    }
    return {
      name: 'Time Deposit',
      shortName: `TD`,
      recurring: false,
      tenure: 0,
      maturity: 0,
    };
  }

  if (normalized.includes('recurring deposit scheme')) {
    const match = instrumentsText.match(
      /(\d+)\s*year\s*recurring deposit scheme/i
    );
    if (match) {
      const tenure = parseInt(match[1], 10);
      return {
        name: 'Recurring Deposit',
        shortName: 'RD',
        recurring: true,
        tenure: tenure,
        maturity: tenure,
      };
    }
    return {
      name: 'Recurring Deposit',
      shortName: 'RD',
      recurring: true,
      tenure: 0,
      maturity: 0,
    };
  }

  if (normalized.includes('national savings certificate')) {
    return {
      name: instrumentsText,
      shortName: 'NSC',
      recurring: false,
      tenure: 5,
      maturity: 5,
    };
  }

  if (normalized.includes('mahila samman savings certificate')) {
    return {
      name: instrumentsText,
      shortName: 'MSSC',
      recurring: false,
      tenure: 2,
      maturity: 2,
    };
  }

  if (normalized.includes('sukanya samriddhi account scheme')) {
    return {
      name: instrumentsText.replace('Scheme', '').trim(),
      shortName: 'SSA',
      recurring: true,
      tenure: 15,
      maturity: 21,
    };
  }

  if (normalized.includes('public provident fund scheme')) {
    return {
      name: instrumentsText.replace('Scheme', '').trim(),
      shortName: 'PPF',
      recurring: true,
      tenure: 15,
      maturity: 15,
    };
  }

  if (normalized.includes('senior citizen savings scheme')) {
    return {
      name: instrumentsText,
      shortName: 'SCSS',
      recurring: false,
      tenure: 5,
      maturity: 5,
    };
  }

  if (normalized.includes('monthly income account')) {
    return {
      name: instrumentsText.replace('Account', 'Scheme').trim(),
      shortName: 'MIS',
      recurring: false,
      tenure: 5,
      maturity: 5,
    };
  }

  if (normalized.includes('post office savings account')) {
    return {
      name: instrumentsText,
      shortName: 'SB',
      recurring: true,
      tenure: 0,
      maturity: 0,
    };
  }

  if (normalized.includes('kisan vikas patra')) {
    return {
      name: instrumentsText,
      shortName: 'KVP',
      recurring: false,
      tenure: 0,
      maturity: 0,
    };
  }

  return {
    name: instrumentsText,
    shortName: instrumentsText
      .split(' ')
      .map((n) => n[0])
      .join(''),
    recurring: false,
    tenure: 0,
    maturity: 0,
  };
}

function compoundingFrequencyStringToValue(compoundingFrequencyString) {
  switch (compoundingFrequencyString) {
    case 'Monthly':
      return 12;

    case 'Quarterly':
      return 4;

    case 'Annually':
    default:
      return 1;
  }
}

extractInterestRates();
