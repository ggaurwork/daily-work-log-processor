// ============================================================
//  DAILY LOG PROCESSOR  v2  — Google Apps Script
//  AI Engine : Gemini API (gemini-2.5-flash, structured JSON)
//  Model     : Bind this script to ONE "Control Panel" Doc.
//              All processing targets the daily file found in
//              ROOT_FOLDER by date — NOT the active document.
//  Output    : Writes into PRE-EXISTING Document Tabs.
//              (Apps Script cannot create tabs; see setup.)
//  Built with Claude | 07 Jun 2026
// ============================================================

// ─────────────────────────────────────────
//  CONFIG  (folder ID is not secret; API key lives in Script Properties)
// ─────────────────────────────────────────
const CONFIG = {
  // "Daily Work Logs" root folder. Script searches it + all subfolders.
  ROOT_FOLDER_ID: '',

  // Optional: a template doc id that already has all 6 tabs.
  TEMPLATE_DOC_ID: '',

  GEMINI_MODEL: 'gemini-2.5-flash',   // current stable; 1.5/2.0 are shut down
  TIMEZONE: 'Asia/Kolkata',
  AUTO_TRIGGER_HOUR: 21,              // ~9 PM IST (Apps Script timing is approximate)

  SOURCE_TAB_NAME: 'Manual Log',
  OUTPUT_TABS: {
    daySummary:    'Day Summary',
    habitsTracker: 'Habits Tracker',
    learnings:     'Learnings',
    ideaIncubator: 'Idea Incubator',
    metrics:       'Metrics'
  }
};

// ─────────────────────────────────────────
//  MENU (appears in the bound Control Panel doc)
// ─────────────────────────────────────────
function onOpen() {
  DocumentApp.getUi()
    .createMenu('📋 Daily Log')
    .addItem("▶ Process Today's Log", 'menuProcessToday')
    .addItem('📅 Process a Specific Date…', 'menuProcessSpecificDate')
    .addItem('🔄 Re-process Today (overwrite)', 'menuReprocessToday')
    .addSeparator()
    .addItem("🆕 Create Today's File from Template", 'menuCreateTodayFile')
    .addSeparator()
    .addItem('⏰ Setup Evening Auto-Trigger', 'setupEveningTrigger')
    .addItem('❌ Remove Auto-Trigger', 'removeEveningTrigger')
    .addItem('ℹ Status', 'showStatus')
    .addToUi();
}

// ─────────────────────────────────────────
//  ENTRY POINTS
// ─────────────────────────────────────────
function menuProcessToday()        { runForDate(getDateString(new Date()), false, true); }
function menuReprocessToday()       { runForDate(getDateString(new Date()), true,  true); }
function processLogAuto()           { runForDate(getDateString(new Date()), false, false); } // trigger

function menuProcessSpecificDate() {
  const ui = DocumentApp.getUi();
  const resp = ui.prompt(
    'Process a specific date',
    'Enter the file title exactly, e.g. "07 Jun, 2026 - SUN":',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const dateStr = resp.getResponseText().trim();
  if (!dateStr) { ui.alert('No date entered.'); return; }
  runForDate(dateStr, true, true);   // explicit date => overwrite allowed
}

// ─────────────────────────────────────────
//  CORE
// ─────────────────────────────────────────
function runForDate(dateString, overwrite, interactive) {
  try {
    Logger.log('▶ Processing date: ' + dateString);

    const file = findDailyFile(dateString, interactive);
    if (!file) return; // findDailyFile already notified

    const doc = DocumentApp.openById(file.getId());

    // Read source tab
    const rawLog = readTabText(doc, CONFIG.SOURCE_TAB_NAME);
    if (!rawLog || rawLog.trim().length < 20) {
      notify('⚠️ "' + CONFIG.SOURCE_TAB_NAME + '" tab is empty/too short in ' + dateString, interactive);
      return;
    }

    // Idempotency guard (per file)
    const props = PropertiesService.getScriptProperties();
    const stampKey = 'PROCESSED_' + file.getId();
    if (!overwrite && props.getProperty(stampKey) === dateString) {
      notify('ℹ Already processed ' + dateString + '. Use "Re-process" to overwrite.', interactive);
      return;
    }

    // Verify all output tabs exist BEFORE calling the API (fail fast, save quota)
    const tabMap = mapTabsByTitle(doc);
    const missing = Object.values(CONFIG.OUTPUT_TABS).filter(t => !tabMap[t]);
    if (missing.length) {
      notify('❌ Missing tab(s) in "' + dateString + '": ' + missing.join(', ') +
             '\n\nCreate them in the doc (or use "Create Today\'s File from Template").', interactive);
      return;
    }

    // AI call
    const structured = callGemini(rawLog, dateString);
    validateStructured(structured);

    // Write each tab
    for (const key in CONFIG.OUTPUT_TABS) {
      writeTab(tabMap[CONFIG.OUTPUT_TABS[key]], CONFIG.OUTPUT_TABS[key], structured[key]);
    }

    doc.saveAndClose();
    props.setProperty(stampKey, dateString);

    notify('✅ Done — populated ' + Object.keys(CONFIG.OUTPUT_TABS).length +
           ' tabs for ' + dateString + '.', interactive);
    Logger.log('✅ Completed ' + dateString);

  } catch (err) {
    Logger.log('ERROR: ' + err.stack);
    notify('❌ Error: ' + err.message + '\n(See Executions log for details.)', interactive);
  }
}

// ─────────────────────────────────────────
//  FILE LOOKUP (recursive, by exact title)
// ─────────────────────────────────────────
function findDailyFile(title, interactive) {
  const root = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
  const matches = [];
  collectByName(root, title, matches);

  const docs = matches.filter(f => f.getMimeType() === MimeType.GOOGLE_DOCS);

  if (docs.length === 0) {
    notify('❌ No Google Doc titled "' + title + '" found under the root folder.', interactive);
    return null;
  }
  if (docs.length === 1) return docs[0];

  // Disambiguate duplicates: prefer the one that actually has a "Manual Log" tab.
  Logger.log('⚠️ ' + docs.length + ' files titled "' + title + '". Disambiguating…');
  for (const f of docs) {
    try {
      const d = DocumentApp.openById(f.getId());
      if (mapTabsByTitle(d)[CONFIG.SOURCE_TAB_NAME]) {
        notify('⚠️ Found ' + docs.length + ' files named "' + title +
               '". Using the one containing a "' + CONFIG.SOURCE_TAB_NAME +
               '" tab. Please trash the extras.', interactive);
        return f;
      }
    } catch (e) { /* skip unreadable */ }
  }
  notify('❌ Multiple files named "' + title + '" and none has a "' +
         CONFIG.SOURCE_TAB_NAME + '" tab. Resolve duplicates first.', interactive);
  return null;
}

function collectByName(folder, name, out) {
  const it = folder.getFilesByName(name);   // exact-name, no query injection
  while (it.hasNext()) out.push(it.next());
  const subs = folder.getFolders();
  while (subs.hasNext()) collectByName(subs.next(), name, out);
}

// ─────────────────────────────────────────
//  TAB HELPERS
// ─────────────────────────────────────────
function mapTabsByTitle(doc) {
  const map = {};
  doc.getTabs().forEach(t => { map[t.getTitle()] = t; });   // top-level tabs only
  return map;
}

function readTabText(doc, tabName) {
  const tab = mapTabsByTitle(doc)[tabName];
  if (!tab) {
    throw new Error('Tab "' + tabName + '" not found. Tabs present: ' +
                    doc.getTabs().map(t => t.getTitle()).join(', '));
  }
  return tab.asDocumentTab().getBody().getText();
}

function writeTab(tab, tabName, content) {
  const body = tab.asDocumentTab().getBody();
  body.clear();

  const heading = body.appendParagraph(tabName);
  heading.setHeading(DocumentApp.ParagraphHeading.HEADING1);

  const ts = body.appendParagraph(
    'Last updated: ' + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "dd MMM yyyy, HH:mm 'IST'")
  );
  ts.setItalic(true);
  body.appendParagraph('');

  (content || '').split('\n').forEach(line => {
    if (line.startsWith('### ')) {
      body.appendParagraph(line.slice(4)).setHeading(DocumentApp.ParagraphHeading.HEADING3);
    } else if (line.startsWith('## ')) {
      body.appendParagraph(line.slice(3)).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      body.appendListItem(line.slice(2)).setGlyphType(DocumentApp.GlyphType.BULLET);
    } else {
      body.appendParagraph(line);   // includes blank lines as spacers
    }
  });

  // Remove the stray empty paragraph left at the very top by clear()
  const first = body.getChild(0);
  if (body.getNumChildren() > 1 &&
      first.getType() === DocumentApp.ElementType.PARAGRAPH &&
      first.asParagraph().getText() === '') {
    body.removeChild(first);
  }
  Logger.log('  ✓ wrote tab: ' + tabName);
}

// ─────────────────────────────────────────
//  GEMINI
// ─────────────────────────────────────────
function getGeminiKey() {
  const k = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!k) throw new Error('GEMINI_API_KEY missing. Add it in Project Settings → Script Properties.');
  return k;
}

function callGemini(rawLog, dateString) {
  const prompt =
    'You are a personal productivity assistant. The date is ' + dateString + '.\n' +
    'Analyse the raw daily log and return the 5 fields defined by the schema.\n' +
    'Inside each field use plain text with this lightweight markdown only:\n' +
    '  "## " for a subheading, "- " for a bullet, blank line between sections.\n' +
    'Be faithful to the log; do not invent facts. If a field has no data, write "- (none logged)".\n\n' +
    'RAW LOG:\n---\n' + rawLog + '\n---';

  const schema = {
    type: 'OBJECT',
    properties: {
      daySummary:    { type: 'STRING' },
      habitsTracker: { type: 'STRING' },
      learnings:     { type: 'STRING' },
      ideaIncubator: { type: 'STRING' },
      metrics:       { type: 'STRING' }
    },
    required: ['daySummary', 'habitsTracker', 'learnings', 'ideaIncubator', 'metrics'],
    propertyOrdering: ['daySummary', 'habitsTracker', 'learnings', 'ideaIncubator', 'metrics']
  };

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              CONFIG.GEMINI_MODEL + ':generateContent';

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': getGeminiKey() },   // key in header, not URL
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    })
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  Logger.log('Gemini HTTP ' + code);
  if (code !== 200) {
    throw new Error('Gemini HTTP ' + code + ': ' + text.slice(0, 300));
  }

  const parsed = JSON.parse(text);
  const cand = parsed && parsed.candidates && parsed.candidates[0];
  const out  = cand && cand.content && cand.content.parts && cand.content.parts[0] &&
               cand.content.parts[0].text;
  if (!out) {
    throw new Error('No candidate text. finishReason=' +
                    (cand && cand.finishReason) + ' raw=' + text.slice(0, 300));
  }

  // With responseMimeType=json the model returns clean JSON. Strip fences defensively.
  const cleaned = out.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    Logger.log('Unparseable model output (debug): ' + cleaned.slice(0, 500));
    throw new Error('Model returned invalid JSON (likely truncated). See log.');
  }
}

function validateStructured(s) {
  ['daySummary', 'habitsTracker', 'learnings', 'ideaIncubator', 'metrics'].forEach(k => {
    if (!s || typeof s[k] !== 'string' || !s[k].trim()) {
      throw new Error('AI output missing/empty field: ' + k);
    }
  });
}

// ─────────────────────────────────────────
//  CREATE TODAY'S FILE FROM TEMPLATE (tabs pre-exist via copy)
// ─────────────────────────────────────────
function menuCreateTodayFile() { createFileForDate(getDateString(new Date()), true); }

function createFileForDate(dateString, interactive) {
  if (!CONFIG.TEMPLATE_DOC_ID) {
    notify('No TEMPLATE_DOC_ID set in CONFIG. Set it to a doc that already has all 6 tabs.', interactive);
    return null;
  }
  const root  = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
  const month = getOrCreateMonthFolder(root, new Date());

  // Skip if it already exists
  const existing = month.getFilesByName(dateString);
  if (existing.hasNext()) {
    notify('ℹ File "' + dateString + '" already exists in ' + month.getName() + '.', interactive);
    return existing.next();
  }
  const copy = DriveApp.getFileById(CONFIG.TEMPLATE_DOC_ID).makeCopy(dateString, month);
  notify('🆕 Created "' + dateString + '" in ' + month.getName() +
         '. Open it and log into the "' + CONFIG.SOURCE_TAB_NAME + '" tab.', interactive);
  return copy;
}

function getOrCreateMonthFolder(root, date) {
  const name = Utilities.formatDate(date, CONFIG.TIMEZONE, 'MMMM yyyy'); // e.g. "June 2026"
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

// ─────────────────────────────────────────
//  TRIGGERS
// ─────────────────────────────────────────
function setupEveningTrigger() {
  removeEveningTrigger();
  ScriptApp.newTrigger('processLogAuto')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.AUTO_TRIGGER_HOUR)
    .nearMinute(0)
    .inTimezone(CONFIG.TIMEZONE)
    .create();
  notify('⏰ Auto-trigger set for ~' + CONFIG.AUTO_TRIGGER_HOUR + ':00 ' + CONFIG.TIMEZONE +
         ' daily.\n(Apps Script fires within the hour, not to the exact minute.)', true);
}

function removeEveningTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processLogAuto')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// ─────────────────────────────────────────
//  STATUS + UTIL
// ─────────────────────────────────────────
function showStatus() {
  const hasTrigger = ScriptApp.getProjectTriggers()
    .some(t => t.getHandlerFunction() === 'processLogAuto');
  notify('ℹ Daily Log Processor\n\n' +
         '🤖 Model         : ' + CONFIG.GEMINI_MODEL + '\n' +
         '📁 Root folder   : ' + DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID).getName() + '\n' +
         '⏰ Auto-trigger  : ' + (hasTrigger ? 'Active (~' + CONFIG.AUTO_TRIGGER_HOUR + ':00 IST)' : 'Not set') + '\n' +
         '📅 Today target  : ' + getDateString(new Date()), true);
}

// Build the EXACT filename format: "07 Jun, 2026 - SUN"
function getDateString(date) {
  const d = Utilities.formatDate(date, CONFIG.TIMEZONE, 'dd MMM, yyyy');   // "07 Jun, 2026"
  const w = Utilities.formatDate(date, CONFIG.TIMEZONE, 'EEE').toUpperCase(); // "SUN"
  return d + ' - ' + w;
}

// UI when interactive, Logger otherwise; never throws on context.
function notify(msg, interactive) {
  if (interactive) {
    try { DocumentApp.getUi().alert(msg); return; } catch (e) { /* fall through */ }
  }
  Logger.log(msg);
}
