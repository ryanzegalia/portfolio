const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// [sanitized: database path resolved from environment config]
const dbPath = path.resolve(__dirname, process.env.DATABASE_PATH || './data/app.db');

let db = null;
let SQL = null;

// Initialize database
async function initDb() {
  if (db) return db;

  SQL = await initSqlJs();

  // Load existing database or create new one
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // Run migrations for existing databases
  runMigrations(db);

  return db;
}

// Run schema migrations
function runMigrations(database) {
  // Check if google_id column exists in users table
  const tableInfo = database.exec("PRAGMA table_info(users)");
  if (tableInfo.length > 0) {
    const columns = tableInfo[0].values.map(row => row[1]); // column names are at index 1

    // Add google_id column if missing (without UNIQUE constraint - SQLite limitation)
    // The UNIQUE constraint is only enforced on new databases via init-db.js
    if (!columns.includes('google_id')) {
      console.log('Migration: Adding google_id column to users table...');
      database.run('ALTER TABLE users ADD COLUMN google_id TEXT');
      // Create an index for google_id lookups (not enforced as UNIQUE but helps performance)
      database.run('CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)');
      console.log('Migration: google_id column added successfully');
    }
  }

  // Check if rejection_note column exists in events table
  const eventsInfo = database.exec("PRAGMA table_info(events)");
  if (eventsInfo.length > 0) {
    const eventColumns = eventsInfo[0].values.map(row => row[1]);

    // Add rejection_note column if missing
    if (!eventColumns.includes('rejection_note')) {
      console.log('Migration: Adding rejection_note column to events table...');
      database.run('ALTER TABLE events ADD COLUMN rejection_note TEXT');
      console.log('Migration: rejection_note column added successfully');
    }
  }

  // Check if state/zip columns exist in venues table
  const venuesInfo = database.exec("PRAGMA table_info(venues)");
  if (venuesInfo.length > 0) {
    const venueColumns = venuesInfo[0].values.map(row => row[1]);

    if (!venueColumns.includes('state')) {
      console.log('Migration: Adding state column to venues table...');
      database.run("ALTER TABLE venues ADD COLUMN state TEXT DEFAULT 'PA'");
      console.log('Migration: state column added successfully');
    }

    if (!venueColumns.includes('zip')) {
      console.log('Migration: Adding zip column to venues table...');
      database.run('ALTER TABLE venues ADD COLUMN zip TEXT');
      console.log('Migration: zip column added successfully');
    }
  }

  // Check if state/zip columns exist in distro_points table
  const distroInfo = database.exec("PRAGMA table_info(distro_points)");
  if (distroInfo.length > 0) {
    const distroColumns = distroInfo[0].values.map(row => row[1]);

    if (!distroColumns.includes('state')) {
      console.log('Migration: Adding state column to distro_points table...');
      database.run("ALTER TABLE distro_points ADD COLUMN state TEXT DEFAULT 'PA'");
      console.log('Migration: state column added successfully');
    }

    if (!distroColumns.includes('zip')) {
      console.log('Migration: Adding zip column to distro_points table...');
      database.run('ALTER TABLE distro_points ADD COLUMN zip TEXT');
      console.log('Migration: zip column added successfully');
    }
  }

  // Check if claiming columns exist in card_requests table
  const cardRequestsInfo = database.exec("PRAGMA table_info(card_requests)");
  if (cardRequestsInfo.length > 0) {
    const requestColumns = cardRequestsInfo[0].values.map(row => row[1]);

    if (!requestColumns.includes('claimed_by_user_id')) {
      console.log('Migration: Adding claimed_by_user_id column to card_requests table...');
      database.run('ALTER TABLE card_requests ADD COLUMN claimed_by_user_id INTEGER REFERENCES users(id)');
      console.log('Migration: claimed_by_user_id column added successfully');
    }

    if (!requestColumns.includes('claimed_at')) {
      console.log('Migration: Adding claimed_at column to card_requests table...');
      database.run('ALTER TABLE card_requests ADD COLUMN claimed_at DATETIME');
      console.log('Migration: claimed_at column added successfully');
    }

    if (!requestColumns.includes('scheduled_window')) {
      console.log('Migration: Adding scheduled_window column to card_requests table...');
      database.run('ALTER TABLE card_requests ADD COLUMN scheduled_window TEXT');
      console.log('Migration: scheduled_window column added successfully');
    }
  }

  // Add phone column to venues table
  if (venuesInfo.length > 0) {
    const venueColumns = venuesInfo[0].values.map(row => row[1]);
    if (!venueColumns.includes('phone')) {
      console.log('Migration: Adding phone column to venues table...');
      database.run('ALTER TABLE venues ADD COLUMN phone TEXT');
      console.log('Migration: phone column added successfully');
    }
  }

  // Add phone column to users table
  if (tableInfo.length > 0) {
    const columns = tableInfo[0].values.map(row => row[1]);
    if (!columns.includes('phone')) {
      console.log('Migration: Adding phone column to users table...');
      database.run('ALTER TABLE users ADD COLUMN phone TEXT');
      console.log('Migration: phone column added successfully');
    }
  }

  // Add approval_status column to distro_points table for crew approval workflow
  // Re-check distroInfo since we may have added columns above
  const distroInfoUpdated = database.exec("PRAGMA table_info(distro_points)");
  if (distroInfoUpdated.length > 0) {
    const distroColumnsUpdated = distroInfoUpdated[0].values.map(row => row[1]);
    if (!distroColumnsUpdated.includes('approval_status')) {
      console.log('Migration: Adding approval_status column to distro_points table...');
      // Default to 'approved' for existing records (they were already active)
      database.run("ALTER TABLE distro_points ADD COLUMN approval_status TEXT DEFAULT 'approved'");
      console.log('Migration: approval_status column added successfully');
    }

    // Add rejection_reason column for optional crew notes on rejection
    if (!distroColumnsUpdated.includes('rejection_reason')) {
      console.log('Migration: Adding rejection_reason column to distro_points table...');
      database.run('ALTER TABLE distro_points ADD COLUMN rejection_reason TEXT');
      console.log('Migration: rejection_reason column added successfully');
    }

    // Add reviewed_by and reviewed_at for audit trail
    if (!distroColumnsUpdated.includes('reviewed_by_user_id')) {
      console.log('Migration: Adding reviewed_by_user_id column to distro_points table...');
      database.run('ALTER TABLE distro_points ADD COLUMN reviewed_by_user_id INTEGER REFERENCES users(id)');
      console.log('Migration: reviewed_by_user_id column added successfully');
    }

    if (!distroColumnsUpdated.includes('reviewed_at')) {
      console.log('Migration: Adding reviewed_at column to distro_points table...');
      database.run('ALTER TABLE distro_points ADD COLUMN reviewed_at DATETIME');
      console.log('Migration: reviewed_at column added successfully');
    }

    // Add status_note column for optional crew messages (used with paused status)
    if (!distroColumnsUpdated.includes('status_note')) {
      console.log('Migration: Adding status_note column to distro_points table...');
      database.run('ALTER TABLE distro_points ADD COLUMN status_note TEXT');
      console.log('Migration: status_note column added successfully');
    }
  }

  // Add deleted_at columns for soft-delete support
  // Users table
  if (tableInfo.length > 0) {
    const columns = tableInfo[0].values.map(row => row[1]);
    if (!columns.includes('deleted_at')) {
      console.log('Migration: Adding deleted_at column to users table...');
      database.run('ALTER TABLE users ADD COLUMN deleted_at DATETIME');
      console.log('Migration: deleted_at column added successfully');
    }
  }

  // Venues table
  if (venuesInfo.length > 0) {
    const venueColumns = venuesInfo[0].values.map(row => row[1]);
    if (!venueColumns.includes('deleted_at')) {
      console.log('Migration: Adding deleted_at column to venues table...');
      database.run('ALTER TABLE venues ADD COLUMN deleted_at DATETIME');
      console.log('Migration: deleted_at column added successfully');
    }
  }

  // Distro points table
  const distroInfoFinal = database.exec("PRAGMA table_info(distro_points)");
  if (distroInfoFinal.length > 0) {
    const distroColumnsFinal = distroInfoFinal[0].values.map(row => row[1]);
    if (!distroColumnsFinal.includes('deleted_at')) {
      console.log('Migration: Adding deleted_at column to distro_points table...');
      database.run('ALTER TABLE distro_points ADD COLUMN deleted_at DATETIME');
      console.log('Migration: deleted_at column added successfully');
    }
  }

  // Events table
  if (eventsInfo.length > 0) {
    const eventColumns = eventsInfo[0].values.map(row => row[1]);
    if (!eventColumns.includes('deleted_at')) {
      console.log('Migration: Adding deleted_at column to events table...');
      database.run('ALTER TABLE events ADD COLUMN deleted_at DATETIME');
      console.log('Migration: deleted_at column added successfully');
    }
  }

  // Add is_active_for_requests to issues table for card request workflow
  const issuesInfo = database.exec("PRAGMA table_info(issues)");
  if (issuesInfo.length > 0) {
    const issueColumns = issuesInfo[0].values.map(row => row[1]);
    if (!issueColumns.includes('is_active_for_requests')) {
      console.log('Migration: Adding is_active_for_requests column to issues table...');
      database.run('ALTER TABLE issues ADD COLUMN is_active_for_requests INTEGER DEFAULT 0');
      console.log('Migration: is_active_for_requests column added successfully');
    }
  }

  // Add issue_id to card_requests table to link requests to specific issues
  const cardRequestsInfoFinal = database.exec("PRAGMA table_info(card_requests)");
  if (cardRequestsInfoFinal.length > 0) {
    const requestColumnsFinal = cardRequestsInfoFinal[0].values.map(row => row[1]);
    if (!requestColumnsFinal.includes('issue_id')) {
      console.log('Migration: Adding issue_id column to card_requests table...');
      database.run('ALTER TABLE card_requests ADD COLUMN issue_id INTEGER REFERENCES issues(id)');
      console.log('Migration: issue_id column added successfully');
    }
  }

  // Create print_runs table for tracking print jobs
  const printRunsExists = database.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='print_runs'");
  if (printRunsExists.length === 0 || printRunsExists[0].values.length === 0) {
    console.log('Migration: Creating print_runs table...');
    database.run(`
      CREATE TABLE IF NOT EXISTS print_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL,
        quantity_ordered INTEGER NOT NULL,
        quantity_received INTEGER DEFAULT 0,
        unit_cost REAL,
        vendor TEXT,
        order_date DATE,
        expected_date DATE,
        received_date DATE,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
      )
    `);
    console.log('Migration: print_runs table created successfully');
  }

  // Add finalization workflow columns to issues table
  const issuesInfoUpdated = database.exec("PRAGMA table_info(issues)");
  if (issuesInfoUpdated.length > 0) {
    const issueColumnsUpdated = issuesInfoUpdated[0].values.map(row => row[1]);

    if (!issueColumnsUpdated.includes('content_locked_at')) {
      console.log('Migration: Adding content_locked_at column to issues table...');
      database.run('ALTER TABLE issues ADD COLUMN content_locked_at DATETIME');
      console.log('Migration: content_locked_at column added successfully');
    }

    if (!issueColumnsUpdated.includes('print_deadline')) {
      console.log('Migration: Adding print_deadline column to issues table...');
      database.run('ALTER TABLE issues ADD COLUMN print_deadline DATE');
      console.log('Migration: print_deadline column added successfully');
    }

    if (!issueColumnsUpdated.includes('sent_to_printer_at')) {
      console.log('Migration: Adding sent_to_printer_at column to issues table...');
      database.run('ALTER TABLE issues ADD COLUMN sent_to_printer_at DATETIME');
      console.log('Migration: sent_to_printer_at column added successfully');
    }

    if (!issueColumnsUpdated.includes('received_from_printer_at')) {
      console.log('Migration: Adding received_from_printer_at column to issues table...');
      database.run('ALTER TABLE issues ADD COLUMN received_from_printer_at DATETIME');
      console.log('Migration: received_from_printer_at column added successfully');
    }

    // Add max_events column for configurable event limits per issue
    if (!issueColumnsUpdated.includes('max_events')) {
      console.log('Migration: Adding max_events column to issues table...');
      database.run('ALTER TABLE issues ADD COLUMN max_events INTEGER DEFAULT 10');
      console.log('Migration: max_events column added successfully');
    }
  }

  // Add issue_id to deliveries table to link deliveries to specific issues
  const deliveriesInfo = database.exec("PRAGMA table_info(deliveries)");
  if (deliveriesInfo.length > 0) {
    const deliveryColumns = deliveriesInfo[0].values.map(row => row[1]);
    if (!deliveryColumns.includes('issue_id')) {
      console.log('Migration: Adding issue_id column to deliveries table...');
      database.run('ALTER TABLE deliveries ADD COLUMN issue_id INTEGER REFERENCES issues(id)');
      console.log('Migration: issue_id column added successfully');
    }
  }

  // Add expired status to card_requests (needed for issue deactivation)
  // SQLite doesn't support ALTER CHECK constraints, so we recreate the table
  const cardRequestsCheck = database.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='card_requests'");
  if (cardRequestsCheck.length > 0 && cardRequestsCheck[0].values.length > 0) {
    const createSql = cardRequestsCheck[0].values[0][0];
    if (createSql && !createSql.includes('expired')) {
      console.log('Migration: Adding expired status to card_requests table...');
      database.run('PRAGMA foreign_keys = OFF');
      database.run(`
        CREATE TABLE card_requests_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          distro_point_id INTEGER NOT NULL,
          requested_by_user_id INTEGER,
          quantity INTEGER NOT NULL,
          notes TEXT,
          status TEXT CHECK(status IN ('pending', 'fulfilled', 'cancelled', 'expired')) DEFAULT 'pending',
          issue_id INTEGER REFERENCES issues(id),
          claimed_by_user_id INTEGER REFERENCES users(id),
          claimed_at DATETIME,
          scheduled_window TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          fulfilled_at DATETIME,
          FOREIGN KEY (distro_point_id) REFERENCES distro_points(id) ON DELETE CASCADE,
          FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        )
      `);
      database.run(`
        INSERT INTO card_requests_new
        SELECT id, distro_point_id, requested_by_user_id, quantity, notes, status,
               issue_id, claimed_by_user_id, claimed_at, scheduled_window, created_at, fulfilled_at
        FROM card_requests
      `);
      database.run('DROP TABLE card_requests');
      database.run('ALTER TABLE card_requests_new RENAME TO card_requests');
      database.run('CREATE INDEX IF NOT EXISTS idx_card_requests_status ON card_requests(status)');
      database.run('PRAGMA foreign_keys = ON');
      console.log('Migration: card_requests table updated with expired status');
    }
  }

  // Add scheduled_date column to card_requests for specific date scheduling
  const cardRequestsDateInfo = database.exec("PRAGMA table_info(card_requests)");
  if (cardRequestsDateInfo.length > 0) {
    const dateColumns = cardRequestsDateInfo[0].values.map(row => row[1]);
    if (!dateColumns.includes('scheduled_date')) {
      console.log('Migration: Adding scheduled_date column to card_requests table...');
      database.run('ALTER TABLE card_requests ADD COLUMN scheduled_date DATE');
      console.log('Migration: scheduled_date column added successfully');
    }
  }

  // Migrate issues table to flexible schema (name, issue_type, start_date, end_date)
  // This removes the UNIQUE(month, year) constraint and adds new fields
  const issuesFlexInfo = database.exec("PRAGMA table_info(issues)");
  if (issuesFlexInfo.length > 0) {
    const issueFlexColumns = issuesFlexInfo[0].values.map(row => row[1]);

    if (!issueFlexColumns.includes('name')) {
      console.log('Migration: Upgrading issues table for flexible publishing...');

      const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];

      database.run('PRAGMA foreign_keys = OFF');

      // Create new table with flexible schema
      database.run(`
        CREATE TABLE issues_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          issue_type TEXT CHECK(issue_type IN ('monthly', 'biweekly', 'weekly', 'special')) DEFAULT 'monthly',
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          month INTEGER CHECK(month >= 1 AND month <= 12),
          year INTEGER,
          status TEXT CHECK(status IN ('planning', 'finalized', 'printed', 'distributed')) DEFAULT 'planning',
          front_art_id INTEGER,
          notes TEXT,
          is_active_for_requests INTEGER DEFAULT 0,
          content_locked_at DATETIME,
          print_deadline DATE,
          sent_to_printer_at DATETIME,
          received_from_printer_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Get existing issues and migrate with computed fields
      const existingIssues = database.exec('SELECT * FROM issues');
      if (existingIssues.length > 0 && existingIssues[0].values.length > 0) {
        const columns = existingIssues[0].columns;
        const idIdx = columns.indexOf('id');
        const monthIdx = columns.indexOf('month');
        const yearIdx = columns.indexOf('year');
        const statusIdx = columns.indexOf('status');
        const frontArtIdx = columns.indexOf('front_art_id');
        const notesIdx = columns.indexOf('notes');
        const activeIdx = columns.indexOf('is_active_for_requests');
        const lockedIdx = columns.indexOf('content_locked_at');
        const deadlineIdx = columns.indexOf('print_deadline');
        const sentIdx = columns.indexOf('sent_to_printer_at');
        const receivedIdx = columns.indexOf('received_from_printer_at');
        const createdIdx = columns.indexOf('created_at');
        const updatedIdx = columns.indexOf('updated_at');

        for (const row of existingIssues[0].values) {
          const id = row[idIdx];
          const month = row[monthIdx];
          const year = row[yearIdx];
          const status = row[statusIdx];
          const frontArtId = row[frontArtIdx];
          const notes = row[notesIdx];
          const isActive = row[activeIdx] || 0;
          const contentLocked = row[lockedIdx];
          const printDeadline = row[deadlineIdx];
          const sentToPrinter = row[sentIdx];
          const receivedFromPrinter = row[receivedIdx];
          const createdAt = row[createdIdx];
          const updatedAt = row[updatedIdx];

          // Compute name from month/year
          const name = `${MONTHS[month - 1]} ${year}`;

          // Compute start_date as first of month
          const startDate = `${year}-${String(month).padStart(2, '0')}-01`;

          // Compute end_date as last of month
          const lastDay = new Date(year, month, 0).getDate();
          const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

          database.run(`
            INSERT INTO issues_new (id, name, issue_type, start_date, end_date, month, year,
              status, front_art_id, notes, is_active_for_requests, content_locked_at,
              print_deadline, sent_to_printer_at, received_from_printer_at, created_at, updated_at)
            VALUES (?, ?, 'monthly', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [id, name, startDate, endDate, month, year, status, frontArtId, notes,
              isActive, contentLocked, printDeadline, sentToPrinter, receivedFromPrinter,
              createdAt, updatedAt]);
        }
      }

      // Drop old table and rename new
      database.run('DROP TABLE issues');
      database.run('ALTER TABLE issues_new RENAME TO issues');

      // Recreate indexes
      database.run('CREATE INDEX IF NOT EXISTS idx_issues_date_range ON issues(start_date, end_date)');
      database.run('CREATE INDEX IF NOT EXISTS idx_issues_type ON issues(issue_type)');
      database.run('CREATE INDEX IF NOT EXISTS idx_issues_active ON issues(is_active_for_requests)');

      database.run('PRAGMA foreign_keys = ON');
      console.log('Migration: Issues table upgraded successfully');
    }
  }

  // Migration: Add status column to print_runs table
  {
    const cols = database.exec("PRAGMA table_info(print_runs)");
    const hasStatus = cols[0]?.values?.some(col => col[1] === 'status');
    if (!hasStatus) {
      console.log('Migration: Adding status column to print_runs table...');
      database.run("ALTER TABLE print_runs ADD COLUMN status TEXT DEFAULT 'active'");
      console.log('Migration: status column added successfully');
    }
  }

  // Migration: Create analytics tables for self-hosted tracking
  // analytics_pageviews - server-side request tracking
  const pageviewsExists = database.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_pageviews'");
  if (pageviewsExists.length === 0 || pageviewsExists[0].values.length === 0) {
    console.log('Migration: Creating analytics_pageviews table...');
    database.run(`
      CREATE TABLE analytics_pageviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        method TEXT DEFAULT 'GET',
        referrer TEXT,
        user_agent TEXT,
        ip_hash TEXT,
        session_id TEXT,
        user_id INTEGER REFERENCES users(id),
        response_time_ms INTEGER,
        status_code INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    database.run('CREATE INDEX idx_pageviews_timestamp ON analytics_pageviews(timestamp)');
    database.run('CREATE INDEX idx_pageviews_path ON analytics_pageviews(path)');
    database.run('CREATE INDEX idx_pageviews_session ON analytics_pageviews(session_id)');
    console.log('Migration: analytics_pageviews table created successfully');
  }

  // analytics_events - client-side event tracking (clicks, forms, errors)
  const eventsTableExists = database.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_events'");
  if (eventsTableExists.length === 0 || eventsTableExists[0].values.length === 0) {
    console.log('Migration: Creating analytics_events table...');
    database.run(`
      CREATE TABLE analytics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        event_category TEXT,
        event_label TEXT,
        event_value TEXT,
        path TEXT NOT NULL,
        session_id TEXT,
        user_id INTEGER REFERENCES users(id),
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    database.run('CREATE INDEX idx_events_timestamp ON analytics_events(timestamp)');
    database.run('CREATE INDEX idx_events_type ON analytics_events(event_type)');
    database.run('CREATE INDEX idx_events_category ON analytics_events(event_category)');
    console.log('Migration: analytics_events table created successfully');
  }

  // analytics_daily - pre-aggregated daily stats for fast dashboard queries
  const dailyExists = database.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_daily'");
  if (dailyExists.length === 0 || dailyExists[0].values.length === 0) {
    console.log('Migration: Creating analytics_daily table...');
    database.run(`
      CREATE TABLE analytics_daily (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date DATE NOT NULL,
        path TEXT NOT NULL,
        pageviews INTEGER DEFAULT 0,
        unique_visitors INTEGER DEFAULT 0,
        avg_response_time_ms INTEGER,
        UNIQUE(date, path)
      )
    `);
    database.run('CREATE INDEX idx_daily_date ON analytics_daily(date)');
    console.log('Migration: analytics_daily table created successfully');
  }
}

// Save database to file
// Uses temp file + fsync + rename instead of writeFileSync because
// writeFileSync doesn't reliably flush to disk on Windows (data stays
// in OS file cache and can be lost on restart/crash).
function atomicWrite(filePath, buffer) {
  const tmpPath = filePath + '.tmp';
  const fd = fs.openSync(tmpPath, 'w');
  fs.writeSync(fd, buffer, 0, buffer.length, 0);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  try { fs.unlinkSync(filePath); } catch (e) { /* file may not exist */ }
  fs.renameSync(tmpPath, filePath);
}

// Live backup path - second copy written on every save
const backupDbPath = dbPath.replace('.db', '-live.db');

function saveDb() {
  if (!db || readOnly) return;
  const data = db.export();
  const buffer = Buffer.from(data);

  atomicWrite(dbPath, buffer);

  // Write live backup copy (non-critical, don't let it break the primary save)
  try { atomicWrite(backupDbPath, buffer); } catch (e) { /* backup write failed, primary is fine */ }

  return { bytes: buffer.length };
}

// Read-only mode: set DB_READONLY=1 for diagnostic scripts that should
// NEVER write to disk. Prevents race conditions when the server is running.
const readOnly = process.env.DB_READONLY === '1';

if (!readOnly) {
  // Auto-save every 30 seconds.
  // unref() prevents this timer from keeping one-off scripts alive as zombies -
  // only processes with other event loop activity (like the HTTP server) will persist.
  setInterval(() => {
    if (db) saveDb();
  }, 30000).unref();

  // Save on exit (server only)
  process.on('exit', saveDb);
  process.on('SIGINT', () => { saveDb(); process.exit(); });
  process.on('SIGTERM', () => { saveDb(); process.exit(); });
}

// Wrapper to provide better-sqlite3-like API
const dbWrapper = {
  prepare: (sql) => ({
    run: (...params) => {
      if (!db) throw new Error('Database not initialized');
      try {
        // sql.js db.run() takes params as second argument (array for ? placeholders)
        if (params.length > 0) {
          db.run(sql, params);
        } else {
          db.run(sql);
        }
        // Get lastInsertRowid using prepared statement (db.exec returns stale data)
        const stmt = db.prepare('SELECT last_insert_rowid() as id');
        let lastId = 0;
        if (stmt.step()) {
          lastId = stmt.getAsObject().id;
        }
        stmt.free();

        saveDb();
        return {
          changes: db.getRowsModified(),
          lastInsertRowid: lastId
        };
      } catch (err) {
        console.error('DB RUN ERROR:', err.message);
        throw err;
      }
    },
    get: (...params) => {
      if (!db) throw new Error('Database not initialized');
      try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
        return undefined;
      } catch (err) {
        console.error('DB GET ERROR:', err.message, 'SQL:', sql, 'Params:', params);
        throw err;
      }
    },
    all: (...params) => {
      if (!db) throw new Error('Database not initialized');
      try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const results = [];
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      } catch (err) {
        console.error('DB ALL ERROR:', err.message, 'SQL:', sql, 'Params:', params);
        throw err;
      }
    }
  }),
  exec: (sql) => {
    if (!db) throw new Error('Database not initialized');
    db.exec(sql);
    saveDb();
  },
  pragma: (pragma) => {
    if (!db) throw new Error('Database not initialized');
    db.run(`PRAGMA ${pragma}`);
  },
  transaction: (fn) => {
    return (...args) => {
      db.run('BEGIN TRANSACTION');
      try {
        fn(...args);
        db.run('COMMIT');
        saveDb();
      } catch (err) {
        db.run('ROLLBACK');
        throw err;
      }
    };
  },
  close: () => {
    if (db) {
      saveDb();
      db.close();
      db = null;
    }
  }
};

// Diagnostic: compare in-memory state with what export() produces
async function getDbDiagnostics() {
  if (!db) return { error: 'Database not initialized' };

  // Count records in the live in-memory db
  const uStmt = db.prepare('SELECT COUNT(*) as c FROM users WHERE deleted_at IS NULL');
  const memUsers = uStmt.step() ? uStmt.getAsObject().c : -1;
  uStmt.free();

  const eStmt = db.prepare('SELECT COUNT(*) as c FROM events WHERE deleted_at IS NULL');
  const memEvents = eStmt.step() ? eStmt.getAsObject().c : -1;
  eStmt.free();

  const vStmt = db.prepare('SELECT COUNT(*) as c FROM venues WHERE deleted_at IS NULL');
  const memVenues = vStmt.step() ? vStmt.getAsObject().c : -1;
  vStmt.free();

  // Export and load into a fresh instance to compare
  const exported = db.export();
  const exportSize = exported.length;

  const freshDb = new SQL.Database(exported);
  const euStmt = freshDb.prepare('SELECT COUNT(*) as c FROM users WHERE deleted_at IS NULL');
  const exportUsers = euStmt.step() ? euStmt.getAsObject().c : -1;
  euStmt.free();

  const eeStmt = freshDb.prepare('SELECT COUNT(*) as c FROM events WHERE deleted_at IS NULL');
  const exportEvents = eeStmt.step() ? eeStmt.getAsObject().c : -1;
  eeStmt.free();

  const evStmt = freshDb.prepare('SELECT COUNT(*) as c FROM venues WHERE deleted_at IS NULL');
  const exportVenues = evStmt.step() ? evStmt.getAsObject().c : -1;
  evStmt.free();
  freshDb.close();

  // Read disk file for comparison
  let diskSize = 0;
  let diskUsers = -1;
  let diskEvents = -1;
  try {
    const diskBuf = fs.readFileSync(dbPath);
    diskSize = diskBuf.length;
    const diskDb = new SQL.Database(diskBuf);
    const duStmt = diskDb.prepare('SELECT COUNT(*) as c FROM users WHERE deleted_at IS NULL');
    diskUsers = duStmt.step() ? duStmt.getAsObject().c : -1;
    duStmt.free();
    const deStmt = diskDb.prepare('SELECT COUNT(*) as c FROM events WHERE deleted_at IS NULL');
    diskEvents = deStmt.step() ? deStmt.getAsObject().c : -1;
    deStmt.free();
    diskDb.close();
  } catch (e) { /* disk read failed */ }

  const match = memUsers === exportUsers && memEvents === exportEvents;

  return {
    dbPath,
    readOnly,
    memory: { users: memUsers, events: memEvents, venues: memVenues },
    exported: { users: exportUsers, events: exportEvents, bytes: exportSize },
    disk: { users: diskUsers, events: diskEvents, bytes: diskSize },
    exportMatchesMemory: match,
    diskMatchesMemory: diskUsers === memUsers && diskEvents === memEvents
  };
}

module.exports = { initDb, dbWrapper, saveDb, getDbDiagnostics };
