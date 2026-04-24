// googleSheets.js — Auto-write outlet submissions to Google Sheets
// Structure: one spreadsheet per outlet, with a dedicated tab per data type.
//
// SETUP (one-time, manual because service accounts can't own Drive files on
// consumer Google accounts):
//   1. Create 4 spreadsheets at sheets.google.com:
//        "Ananda Cafe — Sector 23"
//        "Ananda Cafe — Sector 31"
//        "Ananda Cafe — Sector 56"
//        "Ananda Cafe — Elan"
//   2. Share each with the service account (GOOGLE_SERVICE_EMAIL) as Editor.
//   3. Copy each spreadsheet ID from the URL.
//   4. Insert 4 rows into Supabase `app_config`:
//        key = 'sheet_id_sec23', value = '<id>'
//        key = 'sheet_id_sec31', value = '<id>'
//        key = 'sheet_id_sec56', value = '<id>'
//        key = 'sheet_id_elan',  value = '<id>'
//      (Or set env vars GOOGLE_SHEET_ID_SEC23, _SEC31, _SEC56, _ELAN.)
//   5. Hit GET /api/sheets/setup once — it will create/verify the tabs and
//      headers in each sheet. You don't have to pre-create the tabs.

const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

// Outlet → human-friendly label (used in logs only)
const OUTLET_LABELS = {
  sec23: 'Sector 23',
  sec31: 'Sector 31',
  sec56: 'Sector 56',
  elan:  'Elan',
};

// Tab definitions: name + header row for each data type.
// Order here is the tab order in the spreadsheet.
const TAB_SCHEMA = {
  daily_sales:  {
    name: 'Daily Sales',
    headers: ['Date', 'Submitted At', 'Submitted By', 'Total Sale', 'Swiggy', 'Zomato', 'Other Delivery', 'Cancelled Orders', 'Complimentary Amount', 'Complimentary Reason', 'Zomato District', 'UPI Collected', 'Cash Collected', 'Prev Day Cash', 'Cash Expense', 'Cash Expense Note', 'Cash Deposited', 'Notes'],
  },
  manual:       {
    name: 'Demands',
    headers: ['Date', 'Submitted At', 'Submitted By', 'Slot', 'Status', 'Items', 'Note'],
  },
  bk_demand:    {
    name: 'BK Demands',
    headers: ['Date', 'Submitted At', 'Submitted By', 'Slot', 'Status', 'Items', 'Note'],
  },
  wastage:      {
    name: 'Wastage',
    headers: ['Date', 'Submitted At', 'Submitted By', 'Items', 'Note'],
  },
  closing:      {
    name: 'Closing Stock',
    headers: ['Date', 'Submitted At', 'Submitted By', 'Items', 'Note'],
  },
  purchase:     {
    name: 'Purchases',
    headers: ['Date', 'Submitted At', 'Submitted By', 'Total Amount', 'Payment Mode', 'Items'],
  },
};

// In-memory caches so we don't re-check the same sheet every request
const spreadsheetIdCache = {};          // { sec23: 'abc...', ... }
const tabsVerifiedCache  = {};          // { sec23: true, ... }
let sheetsClient = null;

// ────────────────────────────────────────────────────────────────────────────
// Auth
// ────────────────────────────────────────────────────────────────────────────

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) return null;
  key = key.replace(/\\n/g, '\n'); // Render stores \n as literal backslash-n
  return new google.auth.JWT(email, null, key, SCOPES);
}

async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const auth = getAuth();
  if (!auth) return null;
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// ────────────────────────────────────────────────────────────────────────────
// Spreadsheet ID resolution (env var → app_config → null)
// ────────────────────────────────────────────────────────────────────────────

async function getSpreadsheetIdForOutlet(supabase, outletId) {
  if (spreadsheetIdCache[outletId]) return spreadsheetIdCache[outletId];

  // 1. Env var (e.g. GOOGLE_SHEET_ID_SEC23)
  const envVar = `GOOGLE_SHEET_ID_${outletId.toUpperCase()}`;
  if (process.env[envVar]) {
    spreadsheetIdCache[outletId] = process.env[envVar];
    return spreadsheetIdCache[outletId];
  }

  // 2. Supabase app_config (e.g. sheet_id_sec23)
  if (supabase) {
    const { data } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', `sheet_id_${outletId}`)
      .single();
    if (data?.value) {
      spreadsheetIdCache[outletId] = data.value;
      return spreadsheetIdCache[outletId];
    }
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Tab setup — ensure every tab exists with the right headers.
// Runs once per outlet per process (cached).
// ────────────────────────────────────────────────────────────────────────────

async function ensureTabs(sheets, spreadsheetId, outletId) {
  if (tabsVerifiedCache[outletId]) return;

  // Read existing tab names
  const { data: meta } = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTabs = new Set((meta.sheets || []).map(s => s.properties.title));

  // Figure out which tabs are missing
  const requests = [];
  const tabsToWriteHeaders = [];
  for (const schema of Object.values(TAB_SCHEMA)) {
    if (!existingTabs.has(schema.name)) {
      requests.push({ addSheet: { properties: { title: schema.name } } });
      tabsToWriteHeaders.push(schema);
    }
  }

  // Create any missing tabs in one batch
  if (requests.length > 0) {
    const { data: batchRes } = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests },
    });

    // Write header row for each newly-created tab
    for (const schema of tabsToWriteHeaders) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${schema.name}'!A1`,
        valueInputOption: 'RAW',
        resource: { values: [schema.headers] },
      });
    }

    // Bold + color the header rows (best effort)
    try {
      const formatRequests = [];
      for (const reply of batchRes.replies || []) {
        const newSheetId = reply.addSheet?.properties?.sheetId;
        if (newSheetId != null) {
          formatRequests.push({
            repeatCell: {
              range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.95, green: 0.95, blue: 0.9 },
              } },
              fields: 'userEnteredFormat(textFormat,backgroundColor)',
            },
          });
          formatRequests.push({
            updateSheetProperties: {
              properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount',
            },
          });
        }
      }
      if (formatRequests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          resource: { requests: formatRequests },
        });
      }
    } catch (e) {
      console.log('Header formatting skipped:', e.message);
    }
  }

  tabsVerifiedCache[outletId] = true;
}

// Public: run tab setup for all outlets (called by /api/sheets/setup)
async function setupAllOutlets(supabase) {
  const sheets = await getSheets();
  if (!sheets) throw new Error('Google Sheets auth not configured');

  const results = {};
  for (const outletId of Object.keys(OUTLET_LABELS)) {
    const id = await getSpreadsheetIdForOutlet(supabase, outletId);
    if (!id) {
      results[outletId] = { ok: false, error: 'No spreadsheet ID configured' };
      continue;
    }
    try {
      await ensureTabs(sheets, id, outletId);
      results[outletId] = {
        ok: true,
        spreadsheet_id: id,
        url: `https://docs.google.com/spreadsheets/d/${id}`,
      };
    } catch (e) {
      results[outletId] = { ok: false, error: e.message };
    }
  }
  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// Row builders — one per data type.
// Each returns the row array in the same column order as TAB_SCHEMA[type].headers.
// ────────────────────────────────────────────────────────────────────────────

function formatItemList(items) {
  if (!items || typeof items !== 'object') return '';
  if (Array.isArray(items)) {
    // Purchase-style: [{ name, amount, qty }, ...]
    return items
      .map(i => {
        const name = i.name || i.item || 'item';
        const qty  = i.qty != null ? ` x${i.qty}` : '';
        const amt  = i.amount != null ? ` (₹${i.amount})` : '';
        return `${name}${qty}${amt}`;
      })
      .join(', ');
  }
  // Object: { item_key: qty, ... }
  return Object.entries(items)
    .filter(([_, v]) => v !== '' && v !== null && v !== undefined && v !== 0)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
    .join(', ');
}

function buildRow(type, submittedAt, submittedBy, data, items) {
  const date = data.date || submittedAt.slice(0, 10);

  switch (type) {
    case 'daily_sales':
      return [
        date, submittedAt, submittedBy || '',
        items.total_sale ?? '',
        items.swiggy_sale ?? '',
        items.zomato_sale ?? '',
        items.other_delivery_sale ?? '',
        items.cancelled_orders ?? '',
        items.complimentary_amount ?? '',
        items.complimentary_reason ?? '',
        items.zomato_district ?? '',
        items.upi_collected ?? '',
        items.cash_collected ?? '',
        items.prev_day_cash ?? '',
        items.cash_expense ?? '',
        items.cash_expense_note ?? '',
        items.cash_deposited ?? '',
        items.notes ?? '',
      ];

    case 'manual':
    case 'bk_demand':
      return [
        date, submittedAt, submittedBy || '',
        data.demand_slot || '',
        data.status || '',
        formatItemList(items),
        data.note || '',
      ];

    case 'wastage':
    case 'closing':
      return [
        date, submittedAt, submittedBy || '',
        formatItemList(items),
        data.note || '',
      ];

    case 'purchase':
      return [
        date, submittedAt, submittedBy || '',
        items.total ?? '',
        items.payment_mode || '',
        formatItemList(items.items || []),
      ];

    default:
      return null; // unknown type — skip
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Write a submission to the correct outlet sheet + tab
// ────────────────────────────────────────────────────────────────────────────

async function writeToSheet(supabase, outletId, type, submittedBy, data, items) {
  try {
    if (!OUTLET_LABELS[outletId]) {
      // Silently skip unknown outlets (e.g. 'bk' for purchases at base kitchen)
      return;
    }

    const schema = TAB_SCHEMA[type];
    if (!schema) {
      console.log(`Sheets: no tab schema for type '${type}', skipping`);
      return;
    }

    const sheets = await getSheets();
    if (!sheets) return;

    const spreadsheetId = await getSpreadsheetIdForOutlet(supabase, outletId);
    if (!spreadsheetId) {
      console.log(`Sheets: no spreadsheet configured for outlet '${outletId}'`);
      return;
    }

    await ensureTabs(sheets, spreadsheetId, outletId);

    // IST timestamp
    const now = new Date(Date.now() + 330 * 60000);
    const submittedAt = now.toISOString().replace('T', ' ').slice(0, 19);

    const row = buildRow(type, submittedAt, submittedBy, data || {}, items || {});
    if (!row) return;

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${schema.name}'!A:A`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [row] },
    });

    console.log(`📊 Sheet updated: ${OUTLET_LABELS[outletId]} › ${schema.name} (${type} by ${submittedBy || '—'})`);
  } catch (e) {
    // Never block the main operation — just log.
    console.error(`Google Sheets write error (${outletId}/${type}):`, e.message);
  }
}

module.exports = {
  writeToSheet,
  setupAllOutlets,
  getSpreadsheetIdForOutlet,
  // exposed for debugging
  TAB_SCHEMA,
  OUTLET_LABELS,
};
