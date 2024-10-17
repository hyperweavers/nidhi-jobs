const axios = require('axios');
const { MongoClient, ServerApiVersion } = require('mongodb');

require('dotenv').config();

const DB_URL = process.env.DB_URL || '';
const DB_NAME = process.env.DB_NAME || '';
const DB_COLLECTION = process.env.DB_COLLECTION || '';

const TELEGRAM_API_TOKEN = process.env.TELEGRAM_API_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const HTML_TO_IMAGE_USER_ID = process.env.HTML_TO_IMAGE_USER_ID || '';
const HTML_TO_IMAGE_API_KEY = process.env.HTML_TO_IMAGE_API_KEY || '';

const NIFTY_FIFTY_DATA_API_URL = process.env.NIFTY_FIFTY_DATA_API_URL || '';
const STOCK_DATA_API_URL = process.env.STOCK_DATA_API_URL || '';

const HTML_TO_IMAGE_API_URL = process.env.HTML_TO_IMAGE_API_URL || '';

const TABLE_STYLE = ':root { --primary-color: #e5e7eb; --secondary-color: #374151; --dt-status-up-color: #22c55e; --dt-status-down-color: #ef4444; --dt-background-color-container: #1f2937; --dt-background-color-header: #111827; --dt-padding: 6px; --dt-border-color: var(--secondary-color); --dt-text-color: var(--primary-color); --dt-even-row-color: var(--secondary-color); } table { font-family: sans-serif; background-color: var(--dt-background-color-container); color: var(--dt-text-color); margin: 0 auto; font-size: 12px; border-collapse: collapse; width: 400px; } table, table th, table td { padding: var(--dt-padding) var(--dt-padding); } table th { height: 32px; font-weight: bolder; border-bottom: solid 1px var(--dt-border-color); background-color: var(--dt-background-color-header); } table td { border-bottom: solid 1px var(--dt-border-color); } table td:not(:first-child) { text-align: center; } table tbody tr:nth-child(even) { background-color: var(--dt-even-row-color); } td div:last-child { padding-top: var(--dt-padding); } tr.stock td div.name { font-weight: bold; } tr.stock td div.name span { font-weight: normal; } td div span { padding-left: 2px; } .up { color: var(--dt-status-up-color); } .down { color: var(--dt-status-down-color); } .portfolio { background-color: var(--dt-background-color-header) !important; font-weight: bolder; }';

const NEW_LINE = '%0A';

const getNiftyFiftyData = async () => {
  const { data } = await axios.get(NIFTY_FIFTY_DATA_API_URL).catch((error) => {
    console.error(error.toJSON());

    return Promise.reject();
  });

  return data ? {
    mcIndexId: data.indices.ind_id,
    indexName: data.indices.stkexchg,
    exchange: data.indices.exchange,
    marketState: data.indices.market_state,
    lastUpdated: data.indices.lastupdated,
    price: Number(data.indices.lastprice.replace(/,/g, '')),
    close: Number(data.indices.prevclose.replace(/,/g, '')),
    open: Number(data.indices.open.replace(/,/g, '')),
    dayLow: Number(data.indices.low.replace(/,/g, '')),
    dayHigh: Number(data.indices.high.replace(/,/g, '')),
    yearLow: Number(data.indices.yearlylow.replace(/,/g, '')),
    yearHigh: Number(data.indices.yearlyhigh.replace(/,/g, '')),
    change: {
      direction: Number(data.indices.direction),
      percent: Number(data.indices.percentchange),
      value: Number(data.indices.change.replace(/,/g, '')),
    },
    returns: {
      ytd: Number(data.indices.ytd),
      week: Number(data.indices.week1),
      month: Number(data.indices.month1),
      quarter: Number(data.indices.month3),
      half: Number(data.indices.month6),
      year: Number(data.indices.year1),
      year2: Number(data.indices.year2),
      year3: Number(data.indices.year3),
      year5: Number(data.indices.year5),
    },
    average: {
      day30: Number(data.indices.dayavg30.replace(/,/g, '')),
      day50: Number(data.indices.dayavg50.replace(/,/g, '')),
      day150: Number(data.indices.dayavg150.replace(/,/g, '')),
      day200: Number(data.indices.dayavg200.replace(/,/g, '')),
    },
  } : null;
};

const getPortfolio = async () => {
  const client = new MongoClient(DB_URL, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
  });

  let stocks;

  try {
    await client.connect();

    const db = client.db(DB_NAME);

    stocks = await db.collection(DB_COLLECTION).find().map((doc) => {
      const { _id, ...stock } = doc;

      return stock;
    }).toArray();
  } catch (error) {
    console.error(error);
  } finally {
    await client.close();
  }

  return stocks || null;
};

const getMarketDataForPortfolio = async (portfolio) => {
  const portfolioMap = portfolio.reduce((acc, val) => {
    acc[val.mcStockId] = val;

    return acc;
  }, {});

  const requests = portfolio.map((stock) => {
    return axios.get(`${STOCK_DATA_API_URL}${stock.mcStockId}`).catch((error) => {
      console.error(error.toJSON());

      return Promise.reject();
    });
  });

  const stockQuotes = await Promise.all(requests);

  return stockQuotes.map(({ data }) => (data ? {
    ...(portfolioMap[data.data.priceinfo.id]),
    priceInfo: {
      lastUpdated: data.data.priceinfo.lastupdate,
      price: Number(data.data.priceinfo.lastvalue.replace(/,/g, '')),
      close: Number(data.data.priceinfo.yesterdaysclose.replace(/,/g, '')),
      open: Number(data.data.priceinfo.todaysopen.replace(/,/g, '')),
      dayLow: Number(data.data.priceinfo.daylow.replace(/,/g, '')),
      dayHigh: Number(data.data.priceinfo.dayhigh.replace(/,/g, '')),
      yearLow: Number(data.data.priceinfo.yearlylow.replace(/,/g, '')),
      yearHigh: Number(data.data.priceinfo.yearlyhigh.replace(/,/g, '')),
      lowerCircuit: Number(data.data.priceinfo.lcprice.replace(/,/g, '')),
      upperCircuit: Number(data.data.priceinfo.ucprice.replace(/,/g, '')),
      change: {
        direction: Number(data.data.priceinfo.direction),
        percent: Number(data.data.priceinfo.percentchange),
        value: Number(data.data.priceinfo.CHG.replace(/,/g, '')),
      },
    },
    returns: data.data.returns,
    alerts: data.data.alerts,
  } : null));
};

const calculatePortfolioSummary = (portfolioMarketData) => {
  let portfolioTotalInvestment = 0;
  let portfolioTotalValue = 0;
  let portfolioDayGainLossValue = 0;
  let portfolioCloseValue = 0;

  return {
    holdings: portfolioMarketData.map(stock => {
      const totalQuantity = stock.investments.reduce((a, v) => a + v.quantity, 0);
      const averagePrice = stock.investments.reduce((a, v) => (a + ((v.quantity * v.price) + v.charges)), 0) / totalQuantity;
      const totalInvestment = averagePrice * totalQuantity;
      const totalValue = stock.priceInfo.price * totalQuantity;
      const overallGainLossValue = (stock.priceInfo.price - averagePrice) * totalQuantity;
      const overallGainLossPercent = (overallGainLossValue / totalInvestment) * 100;

      portfolioTotalInvestment += totalInvestment;
      portfolioTotalValue += totalValue;
      portfolioDayGainLossValue += (stock.priceInfo.change.value * totalQuantity);
      portfolioCloseValue += stock.priceInfo.close * totalQuantity;

      return {
        ...stock,
        holding: {
          totalQuantity,
          averagePrice,
          totalInvestment,
          totalValue,
          overallGainLoss: {
            value: overallGainLossValue,
            percent: overallGainLossPercent,
          },
        },
      };
    }),
    dayGainLoss: {
      value: portfolioDayGainLossValue,
      percent: (portfolioDayGainLossValue / portfolioCloseValue) * 100,
    },
    overallGainLoss: {
      value: (portfolioTotalValue - portfolioTotalInvestment),
      percent: (((portfolioTotalValue - portfolioTotalInvestment) / portfolioTotalInvestment) * 100),
    },
    totalInvestment: portfolioTotalInvestment,
    totalValue: portfolioTotalValue,
  };
};

const composePortfolioSummaryTable = (portfolioSummary, niftyFiftyData) => {
  let htmlTableString = `<table>
                          <thead>
                            <tr>
                              <th>Stock Investment</th>
                              <th>Day Gain/Loss</th>
                              <th>Overall Gain/Loss</th>
                            </tr>
                          </thead>
                          <tbody>`;

  htmlTableString += portfolioSummary.holdings.sort((a, b) => b.holding.overallGainLoss.percent - a.holding.overallGainLoss.percent).reduce((acc, val) => {
    acc += `<tr class="stock">
              <td>
                <div class="name">${val.stockName} <span>(${val.holding.totalQuantity})</span></div>
                <div class="investment">${formatNumber(val.holding.averagePrice)} <span>(${formatNumber(val.holding.totalInvestment)})</span></div>
              </td>
              <td class="${getClass(val.priceInfo.change.direction)}">
                <div class="day-value">${formatNumber(val.priceInfo.price)} <span>${getArrow(val.priceInfo.change.direction)}</span></div>
                <div class="day-change">${formatNumber(val.priceInfo.change.value)} <span>(${formatNumber(val.priceInfo.change.percent)}%)</span></div>
              </td>
              <td class="${getClass(val.holding.overallGainLoss.percent)}">
                <div class="total-value">${formatNumber(val.holding.totalValue)} <span>${getArrow(val.holding.overallGainLoss.percent)}</span></div>
                <div class="total-change">${formatNumber(val.holding.overallGainLoss.value)} <span>(${formatNumber(val.holding.overallGainLoss.percent)}%)</span></div>
              </td>
            </tr>`;

    return acc;
  }, '');

  htmlTableString += `<tr class="portfolio">
                        <td colspan="2">
                          <div>Day Gain/Loss</div>
                          <div>Overall Gain/Loss</div>
                        </td>
                        <td>
                          <div class="${getClass(portfolioSummary.dayGainLoss.percent)}">${formatNumber(portfolioSummary.dayGainLoss.value)} <span>(${formatNumber(portfolioSummary.dayGainLoss.percent)}%)</span> <span>${getArrow(portfolioSummary.dayGainLoss.percent)}</span></div>
                          <div class="${getClass(portfolioSummary.overallGainLoss.percent)}">${formatNumber(portfolioSummary.overallGainLoss.value)} <span>(${formatNumber(portfolioSummary.overallGainLoss.percent)}%)</span> <span>${getArrow(portfolioSummary.overallGainLoss.percent)}</span></div>
                        </td>
                      </tr>
                      <tr class="portfolio">
                        <td colspan="2">
                          <div>Total Investment</div>
                          <div>Total Value</div>
                        </td>
                        <td>
                          <div>&#8377; ${formatNumber(portfolioSummary.totalInvestment)}</div>
                          <div>&#8377; ${formatNumber(portfolioSummary.totalValue)}</div>
                        </td>
                      </tr>
                      <tr class="portfolio">
                        <td colspan="2">
                          <div>${niftyFiftyData.indexName}</div>
                          <div>Portfolio (${portfolioSummary.holdings.length})</div>
                        </td>
                        <td>
                          <div class="${getClass(niftyFiftyData.change.percent)}">${formatNumber(niftyFiftyData.change.percent)}% <span>${getArrow(niftyFiftyData.change.percent)}</span></div>
                          <div class="${getClass(portfolioSummary.dayGainLoss.percent)}">${formatNumber(portfolioSummary.dayGainLoss.percent)}% <span>${getArrow(portfolioSummary.dayGainLoss.percent)}</span></div>
                        </td>
                      </tr>
                    </tbody>
                  </table>`;

  return htmlTableString;
};

const convertHtmlToImage = async (html) => {
  const { data } = await axios.post(
    HTML_TO_IMAGE_API_URL,
    {
      html,
      css: TABLE_STYLE,
    },
    {
      auth: {
        username: HTML_TO_IMAGE_USER_ID,
        password: HTML_TO_IMAGE_API_KEY,
      }
    }
  ).catch((error) => {
    console.error(error.toJSON());

    return Promise.reject();
  });

  if (data && !data.url) {
    console.error(data);
  }

  return data?.url || '';
};

const sendMessage = async (documentUrl, caption) => {
  const url = `https://api.telegram.org/bot${TELEGRAM_API_TOKEN}/sendDocument?chat_id=${TELEGRAM_CHAT_ID}&document=${documentUrl}&caption=${caption}&parse_mode=MarkdownV2`;

  const { data } = await axios.post(url).catch((error) => {
    console.error(error.toJSON());

    return Promise.reject();
  });

  return !!data;
};

const getArrow = (value) => (value < 0 ? '&#x25BC;' : '&#x25B2;');

const getClass = (value) => (value < 0 ? 'down' : 'up');

const formatNumber = (value) => (Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value));

const formatDate = (date) => new Date(date).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });

(async () => {
  const niftyFiftyData = await getNiftyFiftyData();

  if (!niftyFiftyData || formatDate(niftyFiftyData.lastUpdated) !== formatDate(new Date())) {
    niftyFiftyData && console.info('Market Closed!');

    return;
  }

  const portfolio = await getPortfolio();

  if (portfolio) {
    const portfolioMarketData = await getMarketDataForPortfolio(portfolio);

    if (portfolioMarketData) {
      const portfolioSummary = calculatePortfolioSummary(portfolioMarketData);
      const portfolioSummaryTable = composePortfolioSummaryTable(portfolioSummary, niftyFiftyData);
      const imageUrl = await convertHtmlToImage(portfolioSummaryTable);

      if (imageUrl) {
        const caption = `
          NIFTY: *${formatNumber(niftyFiftyData.change.percent).replace('-', '\\-').replace('.', '\\.')}%*
          ${NEW_LINE}Portfolio: *${formatNumber(portfolioSummary.dayGainLoss.percent).replace('-', '\\-').replace('.', '\\.')}%*
        `;

        if (await sendMessage(imageUrl, caption)) {
          console.info('Message Sent!');
        } else {
          console.error('Failed to send message!');
        }
      }
    }
  }
})();
