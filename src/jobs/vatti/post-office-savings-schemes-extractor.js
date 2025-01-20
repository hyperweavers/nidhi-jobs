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
        historicInterestRates: scheme.id.startsWith('TD-')
          ? (historicRates['TD'] || []).map((historicRate) => ({
              ...historicRate,
              interestRate:
                historicRate.interestRate.filter(
                  (historicInterestRate) =>
                    scheme.id === `TD-${historicInterestRate.tenure}Y`
                )[0]?.interestRate || 0,
            }))
          : historicRates[scheme.id] || [],
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

  let sbInterestRate;

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

    const {
      id,
      name,
      recurring,
      tenure,
      maturity,
      interestPayoutFrequencyPerYear,
      fixedInterestRate,
      preMaturityPenalty,
      taxExemption,
      limit,
    } = extractTitleAndTenure(instrumentsText);

    if (id) {
      const { interestRate, maturesIn } = parseInterestRate(interestText);

      let frequency = parseCompounding(compoundingText);
      if (id === 'SB') {
        payout = true;
        frequency = 'Annually';
        sbInterestRate = interestRate;
      }

      const frequencyPerYear = compoundingFrequencyStringToValue(frequency);

      let updatedPreMaturityPenalty = preMaturityPenalty;
      if (preMaturityPenalty.length > 0) {
        updatedPreMaturityPenalty = preMaturityPenalty
          .filter((penalty) => !!penalty)
          .map((penalty) => {
            const { interestDeduction, ...updatedPenalty } = penalty;
            let interest;

            if (interestDeduction === null) {
              interest = null;
            } else {
              if (interestDeduction >= 0) {
                interest = interestRate - interestDeduction;
              } else {
                interest = 0;
              }
            }

            return {
              ...updatedPenalty,
              interestRate: interest
                ? Math.round((interest + Number.EPSILON) * 10) / 10
                : interest,
            };
          });
      }

      const rowObject = {
        id,
        name,
        interestRate,
        depositTenure: recurring ? tenure : 0,
        maturityTenure: maturity || maturesIn,
        compoundingFrequencyPerYear: frequencyPerYear,
        interestPayoutFrequencyPerYear,
        fixedInterestRate,
        preMaturityPenalty: updatedPreMaturityPenalty,
        taxExemption,
        limit,
      };

      result.schemes.push(rowObject);
    }
  });

  if (
    result.effective.from &&
    result.effective.to &&
    result.schemes.length === 13
  ) {
    return {
      ...result,
      schemes: result.schemes.map((scheme) => {
        if (scheme.preMaturityPenalty.length > 0) {
          if (
            scheme.preMaturityPenalty.some((penalty) => !penalty.interestRate)
          ) {
            return {
              ...scheme,
              preMaturityPenalty: scheme.preMaturityPenalty.map((penalty) => ({
                ...penalty,
                interestRate:
                  penalty.interestRate === null
                    ? sbInterestRate || -1
                    : penalty.interestRate,
              })),
            };
          } else {
            return scheme;
          }
        } else {
          return scheme;
        }
      }),
    };
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
  return compoundingCellText.replace(/and paid/i, '').trim();
}

function extractTitleAndTenure(instrumentsText) {
  const normalized = normalizeText(instrumentsText);

  if (normalized.includes('post office savings account')) {
    return {
      id: 'SB',
      name: instrumentsText,
      recurring: true,
      tenure: 0,
      maturity: 0,
      interestPayoutFrequencyPerYear: 1,
      fixedInterestRate: false,
      preMaturityPenalty: [],
      taxExemption: {
        principal: 0,
        interest: 10000,
      },
      limit: {
        min: 500,
        max: {
          individual: 0,
          joint: 0,
        },
        multiples: 0,
      },
    };
  }

  if (normalized.includes('recurring deposit scheme')) {
    const match = instrumentsText.match(
      /(\d+)\s*year\s*recurring deposit scheme/i
    );
    if (match) {
      const tenure = parseInt(match[1], 10);
      return {
        id: 'RD',
        name: 'Recurring Deposit',
        recurring: true,
        tenure: tenure,
        maturity: tenure,
        interestPayoutFrequencyPerYear: 0,
        fixedInterestRate: true,
        preMaturityPenalty: [
          {
            from: 3 * 365 + 1,
            to: 0,
            interestDeduction: null, // Replace with SB interest
          },
        ],
        taxExemption: {
          principal: 0,
          interest: 0,
        },
        limit: {
          min: 100,
          max: {
            individual: 0,
            joint: 0,
          },
          multiples: 10,
        },
      };
    }
    return {
      id: '',
      name: 'Recurring Deposit',
      recurring: true,
      tenure: 0,
      maturity: 0,
      interestPayoutFrequencyPerYear: 0,
      fixedInterestRate: true,
      preMaturityPenalty: [],
      taxExemption: {
        principal: 0,
        interest: 0,
      },
      limit: {
        min: 100,
        max: {
          individual: 0,
          joint: 0,
        },
        multiples: 10,
      },
    };
  }

  if (normalized.includes('time deposit')) {
    const match = instrumentsText.match(/(\d+)\s*year\s*time deposit/i);

    if (match) {
      const tenure = parseInt(match[1], 10);
      return {
        id: `TD-${tenure}Y`,
        name: `Time Deposit (${tenure} Year)`,
        recurring: false,
        tenure: tenure,
        maturity: tenure,
        interestPayoutFrequencyPerYear: 1,
        fixedInterestRate: true,
        preMaturityPenalty: [
          {
            from: 0.5 * 365 + 1,
            to: 1 * 365,
            interestDeduction: null, // Replace with SB interest
          },
          tenure > 1
            ? {
                from: 1 * 366 + 1,
                to: 0,
                interestDeduction: 2,
              }
            : undefined,
        ],
        taxExemption: {
          principal: tenure === 5 ? 150000 : 0,
          interest: 0,
        },
        limit: {
          min: 1000,
          max: {
            individual: 0,
            joint: 0,
          },
          multiples: 100,
        },
      };
    }
    return {
      id: '',
      name: 'Time Deposit',
      recurring: false,
      tenure: 0,
      maturity: 0,
      interestPayoutFrequencyPerYear: 1,
      fixedInterestRate: true,
      preMaturityPenalty: [],
      taxExemption: {
        principal: 0,
        interest: 0,
      },
      limit: {
        min: 1000,
        max: {
          individual: 0,
          joint: 0,
        },
        multiples: 100,
      },
    };
  }

  if (normalized.includes('monthly income account')) {
    return {
      id: 'MIS',
      name: instrumentsText.replace('Account', 'Scheme').trim(),
      recurring: false,
      tenure: 5,
      maturity: 5,
      interestPayoutFrequencyPerYear: 12,
      fixedInterestRate: true,
      preMaturityPenalty: [
        {
          from: 1 * 365 + 1,
          to: 3 * 365,
          interestDeduction: 2,
        },
        {
          from: 3 * 365 + 1,
          to: 0,
          interestDeduction: 1,
        },
      ],
      taxExemption: {
        principal: 0,
        interest: 0,
      },
      limit: {
        min: 1000,
        max: {
          individual: 900000,
          joint: 1500000,
        },
        multiples: 1000,
      },
    };
  }

  if (normalized.includes('senior citizen savings scheme')) {
    return {
      id: 'SCSS',
      name: instrumentsText,
      recurring: false,
      tenure: 5,
      maturity: 5,
      interestPayoutFrequencyPerYear: 4,
      fixedInterestRate: true,
      preMaturityPenalty: [
        {
          from: 1,
          to: 1 * 365,
          interestDeduction: -1, // No Interest
        },
        {
          from: 1 * 365 + 1,
          to: 2 * 365,
          interestDeduction: 1.5,
        },
        {
          from: 2 * 365 + 1,
          to: 0,
          interestDeduction: 1,
        },
      ],
      taxExemption: {
        principal: 150000,
        interest: 50000,
      },
      limit: {
        min: 1000,
        max: {
          individual: 3000000,
          joint: 3000000,
        },
        multiples: 1000,
      },
    };
  }

  if (normalized.includes('public provident fund scheme')) {
    return {
      id: 'PPF',
      name: instrumentsText.replace('Scheme', '').trim(),
      recurring: true,
      tenure: 15,
      maturity: 15,
      interestPayoutFrequencyPerYear: 0,
      fixedInterestRate: false,
      preMaturityPenalty: [
        {
          from: 5 * 365 + 1, // After 5 years from the end of the year
          to: 0,
          interestDeduction: 1,
        },
      ],
      taxExemption: {
        principal: 150000,
        interest: -1,
      },
      limit: {
        min: 500,
        max: {
          individual: 150000,
        },
        multiples: 50,
      },
    };
  }

  if (normalized.includes('sukanya samriddhi account scheme')) {
    return {
      id: 'SSA',
      name: instrumentsText.replace('Scheme', '').trim(),
      recurring: true,
      tenure: 15,
      maturity: 21,
      interestPayoutFrequencyPerYear: 0,
      fixedInterestRate: false,
      preMaturityPenalty: [], // Not Allowed
      taxExemption: {
        principal: 150000,
        interest: -1,
      },
      limit: {
        min: 250,
        max: {
          individual: 150000,
        },
        multiples: 50,
      },
    };
  }

  if (normalized.includes('national savings certificate')) {
    return {
      id: 'NSC',
      name: instrumentsText,
      recurring: false,
      tenure: 5,
      maturity: 5,
      interestPayoutFrequencyPerYear: 0,
      fixedInterestRate: true,
      preMaturityPenalty: [], // Not Allowed
      taxExemption: {
        principal: 150000,
        interest: 0,
      },
      limit: {
        min: 1000,
        max: {
          individual: 0,
          joint: 0,
        },
        multiples: 100,
      },
    };
  }

  if (normalized.includes('kisan vikas patra')) {
    return {
      id: 'KVP',
      name: instrumentsText,
      recurring: false,
      tenure: 0,
      maturity: 0,
      interestPayoutFrequencyPerYear: 0,
      fixedInterestRate: true,
      preMaturityPenalty: [
        {
          from: 2.5 * 365 + 1,
          to: 0,
          interestDeduction: 0, // No Penalty
        },
      ],
      taxExemption: {
        principal: 0,
        interest: 0,
      },
      limit: {
        min: 1000,
        max: {
          individual: 0,
          joint: 0,
        },
        multiples: 100,
      },
    };
  }

  if (normalized.includes('mahila samman savings certificate')) {
    return {
      id: 'MSSC',
      name: instrumentsText,
      recurring: false,
      tenure: 2,
      maturity: 2,
      interestPayoutFrequencyPerYear: 0,
      fixedInterestRate: true,
      preMaturityPenalty: [
        {
          from: 0.5 * 365 + 1,
          to: 0,
          interestDeduction: 2,
        },
      ],
      taxExemption: {
        principal: 0,
        interest: 0,
      },
      limit: {
        min: 1000,
        max: {
          individual: 200000,
        },
        multiples: 100,
      },
    };
  }

  return {
    id: '',
    name: instrumentsText,
    recurring: false,
    tenure: 0,
    maturity: 0,
    interestPayoutFrequencyPerYear: 0,
    fixedInterestRate: true,
    preMaturityPenalty: [],
    taxExemption: {
      principal: 0,
      interest: 0,
    },
    limit: {
      min: 0,
      max: {
        individual: 0,
        joint: 0,
      },
      multiples: 0,
    },
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
