// googleSheets.js — Auto-write outlet submissions to Google Sheets
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'];
const SHEET_NAMES = {
  sec23: 'Sector 23',
  sec31: 'Sector 31',
  sec56: 'Sector 56',
  elan: 'Elan',
};

let sheetsClient = null;
let spreadsheetId = null; // Set after first creation or from env

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) return null;
  // Fix escaped newlines
  key = key.replace(/\\n/g, '\n');
  return new google.auth.JWT(email, null, key, SCOPES);
}

async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const auth = getAuth();
  if (!auth) return null;
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// Create a new spreadsheet with tabs for each outlet
async function createSpreadsheet() {
  const sheets = await getSheets();
  if (!sheets) return null;

  const resource = {
    properties: { title: 'Ananda Cafe — Outlet Data' },
    sheets: Object.values(SHEET_NAMES).map(name => ({
      properties: { title: name },
    })),
  };

  const { data } = await sheets.spreadsheets.create({ resource });
  spreadsheetId = data.spreadsheetId;
  console.log(`✅ Created Google Sheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);

  // Add headers to each sheet
  const headers = ['Date', 'Time', 'Type', 'Submitted By', 'Details', 'Items JSON'];
  for (const sheetName of Object.values(SHEET_NAMES)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!A1:F1`,
      valueInputOption: 'RAW',
      resource: { values: [headers] },
    });
  }

  // Make header row bold (via batch update)
  try {
    const sheetIds = data.sheets.map(s => s.properties.sheetId);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: sheetIds.map(sheetId => ({
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.95, green: 0.95, blue: 0.9 } } },
            fields: 'userEnteredFormat(textFormat,backgroundColor)',
          },
        })),
      },
    });
  } catch (e) { console.log('Header formatting skipped:', e.message); }

  return spreadsheetId;
}

// Get or create spreadsheet ID
async function getSpreadsheetId(supabase) {
  if (spreadsheetId) return spreadsheetId;

  // Check if we have it stored in DB
  if (supabase) {
    const { data } = await supabase.from('app_config').select('value').eq('key', 'google_sheet_id').single();
    if (data?.value) {
      spreadsheetId = data.value;
      return spreadsheetId;
    }
  }

  // Create new spreadsheet
  const id = await createSpreadsheet();
  if (id && supabase) {
    await supabase.from('app_config').upsert({ key: 'google_sheet_id', value: id });
  }
  return id;
}

// Format items object into readable string
function formatItems(items, type) {
  if (!items || typeof items !== 'object') return '';
  
  if (type === 'daily_sales') {
    return Object.entries(items)
      .filter(([_, v]) => v !== '' && v !== null && v !== undefined)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
  }

  // For demand/wastage/closing — show item: qty pairs
  return Object.entries(items)
    .filter(([_, v]) => v > 0)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
    .join(', ');
}

// Write a row to the outlet's sheet
async function writeToSheet(supabase, outletId, type, submittedBy, data, rawItems) {
  try {
    const sheets = await getSheets();
    if (!sheets) { console.log('Google Sheets not configured'); return; }

    const sheetId = await getSpreadsheetId(supabase);
    if (!sheetId) { console.log('No spreadsheet ID'); return; }

    const sheetName = SHEET_NAMES[outletId];
    if (!sheetName) { console.log('Unknown outlet:', outletId); return; }

    const now = new Date(Date.now() + 330 * 60000); // IST
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0].slice(0, 5);

    const row = [
      data.date || date,
      time,
      type,
      submittedBy || '',
      formatItems(rawItems, type),
      JSON.stringify(rawItems || {}),
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${sheetName}'!A:F`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [row] },
    });

    console.log(`📊 Sheet updated: ${sheetName} — ${type} by ${submittedBy}`);
  } catch (e) {
    console.error('Google Sheets write error (non-fatal):', e.message);
    // Don't throw — sheet write should never block the main operation
  }
}

module.exports = { writeToSheet, getSpreadsheetId, createSpreadsheet };
