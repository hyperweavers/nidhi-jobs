const axios = require('axios');
const cheerio = require('cheerio');

require('dotenv').config();

const save = process.argv.includes('--save');

const INCOME_TAX_SLABS_DATA_SOURCE_URL =
  process.env.INCOME_TAX_SLABS_DATA_SOURCE_URL || '';
const INCOME_TAX_SLABS_JSON_BLOB = process.env.INCOME_TAX_SLABS_JSON_BLOB || '';


// Function to extract tables from HTML and convert them to JSON
async function extractIncomeTaxSlabs() {
    try {
        if (!INCOME_TAX_SLABS_DATA_SOURCE_URL) {
          console.error('URL is empty!');
          process.exit(1);
        }

        // Fetch data from the URL
        const response = await axios.get(INCOME_TAX_SLABS_DATA_SOURCE_URL);
        const htmlContent = response.data.HtmlContent;

        // Load the HTML content into Cheerio
        const $ = cheerio.load(htmlContent);

        // Extract tables and convert them to JSON
        const tables = [];
        $('table').each((index, table) => {
            const headers = [];
            const rows = [];

            // Extract headers
            $(table).find('thead th').each((i, th) => {
                headers.push($(th).text().trim());
            });

            // Extract rows
            $(table).find('tbody tr').each((i, tr) => {
                const row = {};
                $(tr).find('td').each((j, td) => {
                    row[headers[j]] = $(td).text().trim();
                });
                rows.push(row);
            });

            tables.push(rows);
        });

        console.log(JSON.stringify(tables, null, 2));
    } catch (error) {
        console.error('Error extracting income tax slabs:', error.message);
    }
}

// Run the function
extractIncomeTaxSlabs();
