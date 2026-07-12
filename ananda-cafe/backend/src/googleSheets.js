// googleSheets.js — Auto-write outlet submissions to Google Sheets
// Structure: one spreadsheet per outlet, with a dedicated tab per data type.
//
// Two write formats live here:
//   - Log format (Daily Sales, Purchases, BK Demands): one row appended per
//     submission, in the tab named after the type (TAB_SCHEMA below).
//   - Pivot format (Demands, Closing Stock, Wastage): matches the in-app
//     day-wise CSV download exactly — Item + Unit as rows, one column per
//     date, running left to right through the month, with a Total column.
//     A new tab is created per month (e.g. "Demands – Jul 2026") so a tab
//     never grows unbounded and always matches what a CSV download for that
//     month would show.
//
// SETUP (one-time, manual because service accounts can't own Drive files on
// consumer Google accounts):
//   1. Create 5 spreadsheets at sheets.google.com:
//        "Ananda Cafe — Sector 23"
//        "Ananda Cafe — Sector 31"
//        "Ananda Cafe — Sector 56"
//        "Ananda Cafe — Elan"
//        "Ananda Cafe — Gaur Siddhartham"
//   2. Share each with the service account (GOOGLE_SERVICE_EMAIL) as Editor.
//   3. Copy each spreadsheet ID from the URL.
//   4. Insert rows into Supabase `app_config`:
//        key = 'sheet_id_sec23',   value = '<id>'
//        key = 'sheet_id_sec31',   value = '<id>'
//        key = 'sheet_id_sec56',   value = '<id>'
//        key = 'sheet_id_elan',    value = '<id>'
//        key = 'sheet_id_gaursid', value = '<id>'
//      (Or set env vars GOOGLE_SHEET_ID_SEC23, _SEC31, _SEC56, _ELAN, _GAURSID.)
//   5. Hit GET /api/sheets/setup once — it will create/verify the log-format
//      tabs and headers in each sheet. Pivot tabs (Demands/Closing
//      Stock/Wastage) are created lazily, the first time each month sees a
//      real submission.

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
  sec14: 'Sector 14',
  elan:  'Elan',
  gaursid: 'Gaur Siddhartham',
};

// Log-format tab definitions: name + header row for each data type.
const TAB_SCHEMA = {
  daily_sales:  {
    name: 'Daily Sales',
    headers: ['Date', 'Submitted At', 'Submitted By', 'Total Sale', 'Swiggy', 'Zomato', 'Other Delivery', 'Cancelled Orders', 'Complimentary Amount', 'Complimentary Reason', 'Zomato District', 'UPI Collected', 'Cash Collected', 'Prev Day Cash', 'Cash Expense', 'Cash Expense Note', 'Cash Deposited', 'Notes'],
  },
  bk_demand:    {
    name: 'BK Demands',
    headers: ['Date', 'Submitted At', 'Submitted By', 'Slot', 'Status', 'Items', 'Note'],
  },
  purchase:     {
    name: 'Purchases',
    headers: ['Date', 'Submitted At', 'Submitted By', 'Total Amount', 'Payment Mode', 'Items'],
  },
};

// Pivot-format types: item-rows × date-columns, one tab per calendar month.
// combine: 'sum' merges same-day multi-submissions (e.g. AM + PM demand);
// 'set' overwrites (closing stock is a full-day upsert, not additive).
const PIVOT_SCHEMA = {
  manual:  { name: 'Demands', combine: 'sum' },
  wastage: { name: 'Wastage', combine: 'sum' },
  closing: { name: 'Closing Stock', combine: 'set' },
};

// In-memory caches so we don't re-check the same sheet every request
const spreadsheetIdCache = {};          // { sec23: 'abc...', ... }
const tabsVerifiedCache  = {};          // { sec23: true, ... } — log-format tabs
const pivotTabsVerifiedCache = {};      // { 'sheetId:tabName': true, ... }
let sheetsClient = null;
let demandItemsCache = null;
let demandItemsCacheAt = 0;

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
// Log-format tab setup — ensure every log tab exists with the right headers.
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
// Log-format row builders — one per data type.
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

    case 'bk_demand':
      return [
        date, submittedAt, submittedBy || '',
        data.demand_slot || '',
        data.status || '',
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
// Pivot-format helpers (Demands / Closing Stock / Wastage)
// ────────────────────────────────────────────────────────────────────────────

// item_id → { name, unit } from the demand_items master table. Cached for
// 5 minutes since it changes rarely and every submission would otherwise
// trigger a Supabase round-trip.
async function getDemandItemMap(supabase) {
  const now = Date.now();
  if (demandItemsCache && (now - demandItemsCacheAt) < 5 * 60 * 1000) return demandItemsCache;
  const { data } = await supabase.from('demand_items').select('id, name, unit').eq('active', true);
  const map = {};
  (data || []).forEach(i => { map[i.id] = { name: i.name || i.id, unit: i.unit || '' }; });
  demandItemsCache = map;
  demandItemsCacheAt = now;
  return map;
}

// Closing-stock keys carry a cs_ prefix (cs_butter) — strip it so lookups
// match the same demand_items id used by Demand/Wastage.
function buildItemRows(itemsObj, demandItemMap) {
  return Object.entries(itemsObj || {})
    .filter(([_, v]) => v !== '' && v !== null && v !== undefined && Number(v) !== 0)
    .map(([rawId, qty]) => {
      const id = rawId.startsWith('cs_') ? rawId.slice(3) : rawId;
      const def = demandItemMap[id];
      return { name: def?.name || id.replace(/_/g, ' '), unit: def?.unit || '', qty: Number(qty) || 0 };
    });
}

// "2026-07-08" → "Jul 2026" (same label used by the app's month dropdowns)
function monthLabel(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

async function ensurePivotTab(sheets, spreadsheetId, tabName) {
  const cacheKey = `${spreadsheetId}:${tabName}`;
  if (pivotTabsVerifiedCache[cacheKey]) return;

  const { data: meta } = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = (meta.sheets || []).find(s => s.properties.title === tabName);

  if (!existing) {
    const { data: batchRes } = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: 'RAW',
      resource: { values: [['Item', 'Unit', 'Total']] },
    });

    const newSheetId = batchRes.replies?.[0]?.addSheet?.properties?.sheetId;
    if (newSheetId != null) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          resource: { requests: [
            {
              repeatCell: {
                range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.95, green: 0.95, blue: 0.9 } } },
                fields: 'userEnteredFormat(textFormat,backgroundColor)',
              },
            },
            {
              updateSheetProperties: {
                properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 2 } },
                fields: 'gridProperties(frozenRowCount,frozenColumnCount)',
              },
            },
          ],
        },
        });
      } catch (e) {
        console.log('Pivot header formatting skipped:', e.message);
      }
    }
  }

  pivotTabsVerifiedCache[cacheKey] = true;
}

// Reads the whole month tab, merges in this submission's item quantities for
// one date column, and rewrites the tab in a single call. Tabs are bounded
// to one month (≤31 day-columns, a few dozen item-rows) so a full rewrite
// on every write is cheap and avoids fragile partial-range cell math.
async function writeToPivotSheet(sheets, spreadsheetId, tabName, dayLabel, itemRows, combine) {
  await ensurePivotTab(sheets, spreadsheetId, tabName);

  const { data: current } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A1:ZZ1000` });
  const rows = (current.values && current.values.length > 0) ? current.values.map(r => [...r]) : [['Item', 'Unit', 'Total']];
  const header = rows[0];

  let colIdx = header.findIndex((h, i) => i >= 3 && h === dayLabel);
  if (colIdx === -1) {
    colIdx = header.length;
    header.push(dayLabel);
  }

  const itemRowIndex = {};
  for (let r = 1; r < rows.length; r++) {
    if (rows[r][0]) itemRowIndex[rows[r][0]] = r;
  }

  for (const it of itemRows) {
    let r = itemRowIndex[it.name];
    if (r === undefined) {
      r = rows.length;
      rows.push([it.name, it.unit || '']);
      itemRowIndex[it.name] = r;
    }
    while (rows[r].length <= colIdx) rows[r].push('');
    const existing = Number(rows[r][colIdx]) || 0;
    rows[r][colIdx] = combine === 'sum' ? existing + it.qty : it.qty;
  }

  // Keep every row's Total formula in sync (fixed generous range, cheap to redo)
  for (let r = 1; r < rows.length; r++) {
    while (rows[r].length <= colIdx) rows[r].push('');
    rows[r][2] = `=SUM(D${r + 1}:ZZ${r + 1})`;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [header, ...rows.slice(1)] },
  });
}

// Moves one date's pivot data (Closing Stock / Wastage) to another date, possibly in a
// different month's tab — clears the source column (only the rows that actually had a
// value there) and writes those same values into the target column via the normal
// writeToPivotSheet combine logic (so a 'sum' move onto a target day that already has
// its own entries adds to them, exactly like a fresh submission would).
async function moveDateInSheet(supabase, outletId, type, fromDate, toDate) {
  try {
    if (!OUTLET_LABELS[outletId] || !PIVOT_SCHEMA[type]) return;
    const sheets = await getSheets();
    if (!sheets) return;
    const spreadsheetId = await getSpreadsheetIdForOutlet(supabase, outletId);
    if (!spreadsheetId) return;

    const { name: baseName, combine } = PIVOT_SCHEMA[type];
    const fromTab = `${baseName} – ${monthLabel(fromDate)}`;
    const toTab = `${baseName} – ${monthLabel(toDate)}`;
    const fromLabel = fromDate.slice(5);
    const toLabel = toDate.slice(5);

    await ensurePivotTab(sheets, spreadsheetId, fromTab);
    const { data: srcData } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${fromTab}'!A1:ZZ1000` });
    const srcRows = (srcData.values && srcData.values.length > 0) ? srcData.values.map(r => [...r]) : [['Item', 'Unit', 'Total']];
    const srcHeader = srcRows[0];
    const fromColIdx = srcHeader.findIndex((h, i) => i >= 3 && h === fromLabel);

    const moved = [];
    if (fromColIdx !== -1) {
      for (let r = 1; r < srcRows.length; r++) {
        const val = Number(srcRows[r][fromColIdx]) || 0;
        if (val) {
          moved.push({ name: srcRows[r][0], unit: srcRows[r][1], qty: val });
          srcRows[r][fromColIdx] = '';
        }
      }
      if (moved.length > 0) {
        for (let r = 1; r < srcRows.length; r++) {
          while (srcRows[r].length <= fromColIdx) srcRows[r].push('');
          srcRows[r][2] = `=SUM(D${r + 1}:ZZ${r + 1})`;
        }
        await sheets.spreadsheets.values.update({
          spreadsheetId, range: `'${fromTab}'!A1`, valueInputOption: 'USER_ENTERED',
          resource: { values: [srcHeader, ...srcRows.slice(1)] },
        });
      }
    }

    if (moved.length === 0) return; // nothing was actually in the sheet for that date
    await writeToPivotSheet(sheets, spreadsheetId, toTab, toLabel, moved, combine);
    console.log(`📊 Sheet date moved: ${OUTLET_LABELS[outletId]} › ${baseName} (${fromDate} → ${toDate})`);
  } catch (e) {
    console.error(`Google Sheets move error (${outletId}/${type}):`, e.message);
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

    const sheets = await getSheets();
    if (!sheets) return;

    const spreadsheetId = await getSpreadsheetIdForOutlet(supabase, outletId);
    if (!spreadsheetId) {
      console.log(`Sheets: no spreadsheet configured for outlet '${outletId}'`);
      return;
    }

    // Pivot format: Demands, Wastage, Closing Stock — item rows × date columns,
    // one tab per month, matching the in-app day-wise CSV download exactly.
    if (PIVOT_SCHEMA[type]) {
      const dateStr = (data && data.date) || new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
      const demandItemMap = await getDemandItemMap(supabase);
      const itemRows = buildItemRows(items, demandItemMap);
      if (itemRows.length === 0) return;

      const tabName = `${PIVOT_SCHEMA[type].name} – ${monthLabel(dateStr)}`;
      await writeToPivotSheet(sheets, spreadsheetId, tabName, dateStr.slice(5), itemRows, PIVOT_SCHEMA[type].combine);
      console.log(`📊 Sheet updated (pivot): ${OUTLET_LABELS[outletId]} › ${tabName} (${type} by ${submittedBy || '—'})`);
      return;
    }

    // Log format: Daily Sales, BK Demands, Purchases — one row per submission.
    const schema = TAB_SCHEMA[type];
    if (!schema) {
      console.log(`Sheets: no tab schema for type '${type}', skipping`);
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
  moveDateInSheet,
  setupAllOutlets,
  getSpreadsheetIdForOutlet,
  // exposed for debugging
  TAB_SCHEMA,
  PIVOT_SCHEMA,
  OUTLET_LABELS,
};
