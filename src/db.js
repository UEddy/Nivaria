const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

let db;       // DatabaseWrapper
let sqlDb;    // raw sql.js Database
let dbPath;

// ─── sql.js compatibility adapter ─────────────────────────────────────────────
// Wraps sql.js to provide a better-sqlite3-style synchronous API.

function saveDb() {
  if (!sqlDb || !dbPath) return;
  const data = sqlDb.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

class Statement {
  constructor(sql) {
    this._sql = sql;
  }

  run(...args) {
    sqlDb.run(this._sql, args.length ? args : undefined);
    const rowid = sqlDb.exec('SELECT last_insert_rowid()');
    const lastInsertRowid = Number(rowid[0]?.values[0][0] ?? 0);
    saveDb();
    return { lastInsertRowid };
  }

  get(...args) {
    const stmt = sqlDb.prepare(this._sql);
    try {
      if (args.length) stmt.bind(args);
      if (!stmt.step()) return undefined;
      return stmt.getAsObject();
    } finally {
      stmt.free();
    }
  }

  all(...args) {
    const stmt = sqlDb.prepare(this._sql);
    const rows = [];
    try {
      if (args.length) stmt.bind(args);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }
}

class DatabaseWrapper {
  exec(sql) {
    sqlDb.exec(sql);
    saveDb();
    return this;
  }

  prepare(sql) {
    return new Statement(sql);
  }
}

// ─── Schema & seeding ──────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    tier TEXT DEFAULT 'free' CHECK(tier IN ('free', 'pro', 'team')),
    api_key TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    email_verified INTEGER DEFAULT 0,
    last_login DATETIME,
    session_version INTEGER DEFAULT 1,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('register','reset')),
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    verified_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS competitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT,
    css_selector TEXT,
    render_mode TEXT NOT NULL DEFAULT 'fetch',
    active INTEGER DEFAULT 1,
    last_checked DATETIME,
    last_content_hash TEXT,
    last_check_status TEXT,
    last_check_error TEXT,
    last_check_at DATETIME,
    check_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competitor_id INTEGER NOT NULL,
    content_before TEXT,
    content_after TEXT,
    diff_summary TEXT,
    analysis TEXT,
    threat_level TEXT CHECK(threat_level IN ('low', 'medium', 'high')),
    recommended_response TEXT,
    talking_points TEXT,
    headline TEXT,
    analysis_status TEXT DEFAULT 'ok',
    analysis_error TEXT,
    is_meaningful INTEGER DEFAULT 1,
    gate_category TEXT,
    gate_reason TEXT,
    ai_input_tokens INTEGER,
    ai_output_tokens INTEGER,
    pattern_tags TEXT,
    historical_context TEXT,
    detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (competitor_id) REFERENCES competitors(id)
  );

  CREATE INDEX IF NOT EXISTS idx_changes_competitor_detected
    ON changes(competitor_id, detected_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    slack_webhook TEXT,
    discord_webhook TEXT,
    notification_email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Phase 6: per-user business context fed into every AI analysis prompt so
  -- battle cards reflect the user's ICP, positioning, and deal size instead of
  -- generic outside-observer analysis. All fields nullable — context is
  -- entirely optional and the AI degrades gracefully without it.
  CREATE TABLE IF NOT EXISTS user_context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    company_name TEXT,
    what_we_sell TEXT,
    target_icp TEXT,
    our_positioning TEXT,
    typical_deal_size TEXT CHECK(typical_deal_size IN ('small','mid','large','enterprise') OR typical_deal_size IS NULL),
    sales_motion TEXT CHECK(sales_motion IN ('plg','slg','hybrid') OR sales_motion IS NULL),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Phase 7: calendar OAuth connections. Tokens are AES-256-GCM encrypted by
  -- src/calendarTokens.js before storage. UNIQUE(user_id, provider) means
  -- re-connecting the same provider updates in-place rather than orphaning rows.
  CREATE TABLE IF NOT EXISTS calendar_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')),
    account_email TEXT,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT,
    expires_at DATETIME,
    scope TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','revoked')),
    last_synced_at DATETIME,
    last_sync_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, provider)
  );

  -- Phase 7: per-meeting state cached from the calendar provider, plus the
  -- match against tracked competitors and the briefing dispatch state.
  -- UNIQUE(user_id, provider, external_event_id) makes sync idempotent.
  CREATE TABLE IF NOT EXISTS tracked_meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    connection_id INTEGER,
    provider TEXT NOT NULL,
    external_event_id TEXT NOT NULL,
    title TEXT,
    start_time DATETIME NOT NULL,
    end_time DATETIME,
    attendees TEXT,
    matched_competitor_id INTEGER,
    match_reason TEXT CHECK(match_reason IN ('title','domain','manual','none') OR match_reason IS NULL),
    briefing_status TEXT DEFAULT 'pending' CHECK(briefing_status IN ('pending','sent','skipped','failed')),
    briefing_sent_at DATETIME,
    briefing_error TEXT,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (matched_competitor_id) REFERENCES competitors(id),
    UNIQUE(user_id, provider, external_event_id)
  );

  CREATE INDEX IF NOT EXISTS idx_tracked_meetings_dispatch
    ON tracked_meetings(briefing_status, start_time);
  CREATE INDEX IF NOT EXISTS idx_tracked_meetings_user_start
    ON tracked_meetings(user_id, start_time);
  CREATE INDEX IF NOT EXISTS idx_tracked_meetings_competitor
    ON tracked_meetings(matched_competitor_id, start_time);

  -- Phase 8: per-user voice calibration profile. One row per user. All fields
  -- nullable; the playbook generator falls back to sensible defaults when a
  -- row is missing or partially filled. voice_sample and avoid_phrases are
  -- free-text user input — the playbook module sanitizes them before feeding
  -- to the AI prompt to defuse prompt-injection.
  CREATE TABLE IF NOT EXISTS user_voice_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    formality TEXT CHECK(formality IN ('casual','balanced','formal') OR formality IS NULL),
    contraction_style TEXT CHECK(contraction_style IN ('always','sometimes','never') OR contraction_style IS NULL),
    opener_style TEXT CHECK(opener_style IN ('direct','warm','context-first') OR opener_style IS NULL),
    sentence_rhythm TEXT CHECK(sentence_rhythm IN ('short_punchy','mixed','measured') OR sentence_rhythm IS NULL),
    sign_off_examples TEXT,
    voice_sample TEXT,
    avoid_phrases TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Phase 8: ready-to-send outreach messages generated per meaningful change,
  -- tied to the user who owns the underlying change. Lookup is keyed by
  -- (change_id, user_id) so the battle-card render fetches all variants in
  -- one indexed read.
  CREATE TABLE IF NOT EXISTS generated_playbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    change_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    message_type TEXT NOT NULL CHECK(message_type IN ('email_to_prospect','slack_to_team','followup_email')),
    subject_line TEXT,
    body TEXT NOT NULL,
    ai_input_tokens INTEGER,
    ai_output_tokens INTEGER,
    estimated_cost_usd REAL,
    generation_status TEXT DEFAULT 'ok',
    generation_error TEXT,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    regenerated_count INTEGER DEFAULT 0,
    FOREIGN KEY (change_id) REFERENCES changes(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_playbooks_change_user
    ON generated_playbooks(change_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_playbooks_user_recent
    ON generated_playbooks(user_id, generated_at DESC);
`;

async function initDb() {
  const dataDir = path.join(__dirname, '../data');
  fs.mkdirSync(dataDir, { recursive: true });
  dbPath = path.join(dataDir, 'competitor-shadow.db');

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    sqlDb = new SQL.Database(buf);
  } else {
    sqlDb = new SQL.Database();
  }

  db = new DatabaseWrapper();

  sqlDb.exec(SCHEMA);

  // Migrate existing users table if columns are missing
  const userCols = (sqlDb.exec('PRAGMA table_info(users)')[0]?.values || []).map(v => v[1]);
  if (!userCols.includes('password_hash'))   sqlDb.run('ALTER TABLE users ADD COLUMN password_hash TEXT');
  if (!userCols.includes('email_verified'))  sqlDb.run('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0');
  if (!userCols.includes('last_login'))      sqlDb.run('ALTER TABLE users ADD COLUMN last_login DATETIME');
  if (!userCols.includes('session_version')) sqlDb.run('ALTER TABLE users ADD COLUMN session_version INTEGER DEFAULT 1');

  // Migrate competitors table for P0 check-status tracking
  const compCols = (sqlDb.exec('PRAGMA table_info(competitors)')[0]?.values || []).map(v => v[1]);
  if (!compCols.includes('last_check_status')) sqlDb.run('ALTER TABLE competitors ADD COLUMN last_check_status TEXT');
  if (!compCols.includes('last_check_error'))  sqlDb.run('ALTER TABLE competitors ADD COLUMN last_check_error TEXT');
  if (!compCols.includes('last_check_at'))     sqlDb.run('ALTER TABLE competitors ADD COLUMN last_check_at DATETIME');
  // Phase 2: per-competitor CSS selector override for noise reduction
  if (!compCols.includes('css_selector'))      sqlDb.run('ALTER TABLE competitors ADD COLUMN css_selector TEXT');
  // Phase 3: per-competitor render mode — 'fetch' (axios+cheerio) or 'js' (Playwright)
  if (!compCols.includes('render_mode'))       sqlDb.run("ALTER TABLE competitors ADD COLUMN render_mode TEXT NOT NULL DEFAULT 'fetch'");

  // Migrate changes table to support analyzer-failure backfill
  const changeCols = (sqlDb.exec('PRAGMA table_info(changes)')[0]?.values || []).map(v => v[1]);
  if (!changeCols.includes('analysis_status')) sqlDb.run("ALTER TABLE changes ADD COLUMN analysis_status TEXT DEFAULT 'ok'");
  if (!changeCols.includes('analysis_error'))  sqlDb.run('ALTER TABLE changes ADD COLUMN analysis_error TEXT');
  // Phase 4: meaningful-change gate + AI token tracking
  if (!changeCols.includes('is_meaningful'))    sqlDb.run('ALTER TABLE changes ADD COLUMN is_meaningful INTEGER DEFAULT 1');
  if (!changeCols.includes('gate_category'))    sqlDb.run('ALTER TABLE changes ADD COLUMN gate_category TEXT');
  if (!changeCols.includes('gate_reason'))      sqlDb.run('ALTER TABLE changes ADD COLUMN gate_reason TEXT');
  if (!changeCols.includes('ai_input_tokens'))  sqlDb.run('ALTER TABLE changes ADD COLUMN ai_input_tokens INTEGER');
  if (!changeCols.includes('ai_output_tokens')) sqlDb.run('ALTER TABLE changes ADD COLUMN ai_output_tokens INTEGER');
  // Phase 5: historical pattern analysis — tag each change for cross-time grouping,
  // and persist the AI's narrative on how the change fits the competitor's trajectory.
  if (!changeCols.includes('pattern_tags'))       sqlDb.run('ALTER TABLE changes ADD COLUMN pattern_tags TEXT');
  if (!changeCols.includes('historical_context')) sqlDb.run('ALTER TABLE changes ADD COLUMN historical_context TEXT');

  // Phase 6: audit flag — did the AI have user business context to work from?
  // Lets us measure context coverage and surface "Analyzed for: …" in the UI.
  if (!changeCols.includes('context_used')) sqlDb.run('ALTER TABLE changes ADD COLUMN context_used INTEGER DEFAULT 0');

  // Phase 7: bare domain ("acme.com") on each competitor for attendee-email
  // matching. Backfilled from URL below for any rows that pre-date this column.
  if (!compCols.includes('domain')) {
    sqlDb.run('ALTER TABLE competitors ADD COLUMN domain TEXT');
    try {
      const rows = (sqlDb.exec('SELECT id, url FROM competitors')[0]?.values || []);
      for (const [id, url] of rows) {
        const domain = extractDomainFromUrl(url);
        if (domain) sqlDb.run('UPDATE competitors SET domain = ? WHERE id = ?', [domain, id]);
      }
    } catch (e) {
      console.warn('Phase 7 domain backfill failed (non-fatal):', e.message);
    }
  }

  // Phase 7: per-user briefing preferences. Lives on the existing settings
  // table to avoid duplicating webhook config — slack_webhook/discord_webhook
  // already exist here and are reused as the briefing delivery channel.
  const settingsCols = (sqlDb.exec('PRAGMA table_info(settings)')[0]?.values || []).map(v => v[1]);
  if (!settingsCols.includes('briefings_enabled'))     sqlDb.run('ALTER TABLE settings ADD COLUMN briefings_enabled INTEGER DEFAULT 1');
  if (!settingsCols.includes('briefing_lead_minutes')) sqlDb.run('ALTER TABLE settings ADD COLUMN briefing_lead_minutes INTEGER DEFAULT 30');

  // Phase 5: speed up per-competitor reverse-chronological lookups used by
  // historicalContext.getCompetitorHistory and the new timeline endpoints.
  sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_changes_competitor_detected ON changes(competitor_id, detected_at DESC);');

  saveDb();

  const existingUser = db.prepare('SELECT id FROM users WHERE id = 1').get();
  if (!existingUser) {
    const apiKey = 'cs-' + uuidv4().replace(/-/g, '');
    db.prepare('INSERT INTO users (email, name, tier, api_key) VALUES (?, ?, ?, ?)')
      .run('demo@foresight.com', 'Demo User', 'pro', apiKey);
    db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(1);
    seedDemoData();
    console.log(`\n✅ Demo account created. API Key: ${apiKey}\n`);
  }

  // Ensure demo user has a password for testing
  const demoUser = db.prepare('SELECT id, password_hash FROM users WHERE id = 1').get();
  if (demoUser && !demoUser.password_hash) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('Demo1234!', 12);
    db.prepare('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = 1').run(hash);
    saveDb();
    console.log('✅ Demo credentials: demo@foresight.com / Demo1234!');
  }

  saveDb();
  console.log('✅ Database initialized');
  return db;
}

function seedDemoData() {
  const now = new Date();
  const ts = (offsetMs) => new Date(now - offsetMs).toISOString().replace('T', ' ').slice(0, 19);

  const c1 = db.prepare('INSERT INTO competitors (user_id, name, url, description, last_checked, last_content_hash, check_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(1, 'Acme Corp', 'https://acmecorp.com/pricing', 'Primary competitor in our core market segment', ts(3600000), 'hash_acme_001', 24).lastInsertRowid;
  const c2 = db.prepare('INSERT INTO competitors (user_id, name, url, description, last_checked, last_content_hash, check_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(1, 'NovaTech', 'https://novatech.io/features', 'Fast-growing startup targeting our SMB customers', ts(7200000), 'hash_nova_001', 18).lastInsertRowid;
  const c3 = db.prepare('INSERT INTO competitors (user_id, name, url, description, last_checked, last_content_hash, check_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(1, 'Horizon AI', 'https://horizonai.com', 'AI-first competitor, recently raised Series B', ts(21600000), 'hash_horizon_001', 31).lastInsertRowid;

  const highAnalysis = JSON.stringify({
    headline: 'Acme Corp slashed Pro plan pricing by 30%, an aggressive market move',
    summary: 'Acme Corp reduced their Pro plan from $49/mo to $34/mo and removed the seat limit. This is a significant pricing response likely targeting our recent customer wins. They also added a new "Starter" tier at $9/mo.',
    threat_level: 'high',
    threat_reasoning: 'Direct price undercut on our core plan with unlimited seats threatens our mid-market positioning.',
    recommended_response: 'Immediate sales team briefing required. Prepare competitive pricing rebuttals and emphasize superior support and integrations.',
    talking_points: [
      'Our platform includes enterprise SSO and audit logs at the Pro level. Acme charges extra for these',
      'We offer 99.9% SLA with dedicated support; Acme Pro only includes email support',
      'Our API rate limits are 10x higher than Acme at equivalent tiers',
      'Migration from Acme takes 2-3 weeks; we offer free white-glove onboarding'
    ],
    key_changes: [
      { category: 'pricing', description: 'Pro plan reduced from $49 to $34/mo', impact: 'Direct competitive threat to our primary revenue tier' },
      { category: 'pricing', description: 'New $9/mo Starter tier added', impact: 'Now competes in the SMB entry market we currently own' },
      { category: 'features', description: 'Seat limits removed from Pro plan', impact: 'Eliminates a key objection prospects previously raised against Acme' }
    ],
    opportunity: 'Aggressive pricing signals margin pressure. Emphasize stability and longevity in enterprise deals.'
  });

  const medAnalysis = JSON.stringify({
    headline: 'NovaTech launches AI writing assistant: enters our core feature territory',
    summary: 'NovaTech has quietly launched an AI-powered content generation feature that directly competes with our core offering. Currently in beta but prominently featured on their homepage.',
    threat_level: 'medium',
    threat_reasoning: 'Feature parity in a differentiated area, but NovaTech lacks our integrations ecosystem and enterprise credibility.',
    recommended_response: 'Accelerate roadmap items that further differentiate our AI capabilities. Brief sales team with comparison talking points.',
    talking_points: [
      'Our AI has been in production for 18 months with 500M+ documents processed. NovaTech is just starting',
      'We offer fine-tuning on company data; NovaTech uses generic models only',
      'Our compliance certifications (SOC2, HIPAA) cover AI features, critical for enterprise',
      'We integrate with 150+ tools; NovaTech supports 12'
    ],
    key_changes: [
      { category: 'features', description: 'AI writing assistant launched in beta', impact: 'Enters our primary differentiation area' },
      { category: 'messaging', description: 'Homepage now leads with AI messaging', impact: 'Repositioning toward our target buyer' }
    ],
    opportunity: 'Their beta launch gives us time to showcase production maturity. Create case studies highlighting AI ROI.'
  });

  const lowAnalysis = JSON.stringify({
    headline: 'Horizon AI updates case studies and adds two Fortune 500 logos',
    summary: 'Horizon AI refreshed their customer evidence page with two new Fortune 500 case studies and updated their ROI calculator. No product or pricing changes detected.',
    threat_level: 'low',
    threat_reasoning: 'Social proof improvements are positive for them but do not represent immediate competitive threat.',
    recommended_response: 'Update our own case study page if any similar wins are available. Ensure sales team is aware Horizon is targeting enterprise accounts.',
    talking_points: [
      'We have 3x more enterprise case studies across more industries',
      'Our G2 rating is 4.8 vs Horizon\'s 4.2 with significantly more reviews',
      'Our implementation timeline is 4 weeks vs Horizon\'s 12-week average'
    ],
    key_changes: [
      { category: 'messaging', description: 'Two new Fortune 500 logos added', impact: 'Improves enterprise credibility' },
      { category: 'features', description: 'ROI calculator updated', impact: 'Better sales enablement tool for their reps' }
    ],
    opportunity: 'If they are closing Fortune 500 deals, the market is validating enterprise demand. Ensure compelling enterprise proof points are ready.'
  });

  db.prepare('INSERT INTO changes (competitor_id, diff_summary, analysis, threat_level, recommended_response, talking_points, headline, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c1, JSON.stringify({ added: ['$34', 'Starter', 'unlimited seats'], removed: ['$49', 'per seat'] }),
      highAnalysis, 'high', 'Immediate sales team briefing required.',
      JSON.stringify(['Enterprise SSO included', 'Our 99.9% SLA', 'API rate limits 10x higher']),
      'Acme Corp slashed Pro plan pricing by 30%, an aggressive market move', ts(86400000));

  db.prepare('INSERT INTO changes (competitor_id, diff_summary, analysis, threat_level, recommended_response, talking_points, headline, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c2, JSON.stringify({ added: ['AI', 'writing assistant', 'beta'], removed: [] }),
      medAnalysis, 'medium', 'Accelerate roadmap AI differentiation.',
      JSON.stringify(['18 months production history', 'Fine-tuning on company data', 'SOC2/HIPAA certified']),
      'NovaTech launches AI writing assistant: enters our core feature territory', ts(259200000));

  db.prepare('INSERT INTO changes (competitor_id, diff_summary, analysis, threat_level, recommended_response, talking_points, headline, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c3, JSON.stringify({ added: ['Fortune 500', 'case study'], removed: [] }),
      lowAnalysis, 'low', 'Update our own case study page.',
      JSON.stringify(['3x more enterprise case studies', 'G2 rating 4.8 vs 4.2', '4-week implementation']),
      'Horizon AI updates case studies and adds two Fortune 500 logos', ts(86400000));

  saveDb();
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

// Phase 7 helper — extract bare domain from a URL (used by the migration and
// re-used by routes/competitors when a competitor row is created/updated).
function extractDomainFromUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch (_) { return null; }
}

module.exports = { initDb, getDb, extractDomainFromUrl };
