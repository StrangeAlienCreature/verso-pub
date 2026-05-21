const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'bookclub.db'));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- Server book list
  CREATE TABLE IF NOT EXISTS books (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    author      TEXT    DEFAULT 'Unknown Author',
    cover_url   TEXT,
    description TEXT,
    source_url  TEXT,
    total_pages INTEGER,
    added_by    TEXT    NOT NULL,
    added_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_current  INTEGER  DEFAULT 0
  );

  -- Active polls
  CREATE TABLE IF NOT EXISTS polls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    channel_id  TEXT    NOT NULL,
    message_id  TEXT,
    status      TEXT    DEFAULT 'active',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at   DATETIME
  );

  -- Books included in a poll (up to 9, one per emoji)
  CREATE TABLE IF NOT EXISTS poll_options (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id   INTEGER NOT NULL REFERENCES polls(id),
    book_id   INTEGER NOT NULL REFERENCES books(id),
    emoji     TEXT    NOT NULL,
    votes     INTEGER DEFAULT 0
  );

  -- Reading progress per user per book
  CREATE TABLE IF NOT EXISTS progress (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    user_id     TEXT    NOT NULL,
    book_id     INTEGER NOT NULL REFERENCES books(id),
    current_page INTEGER,
    total_pages INTEGER,
    percent     REAL,
    note        TEXT,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(guild_id, user_id, book_id)
  );

  -- User profiles (reading platform connections)
  CREATE TABLE IF NOT EXISTS profiles (
    user_id              TEXT PRIMARY KEY,
    storygraph_username  TEXT,
    goodreads_user_id    TEXT,
    goodreads_username   TEXT,
    updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Reading log history (each time user logs progress)
  CREATE TABLE IF NOT EXISTS progress_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    user_id     TEXT    NOT NULL,
    book_id     INTEGER NOT NULL,
    percent     REAL,
    note        TEXT,
    logged_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─── Books ───────────────────────────────────────────────────────────────────

const bookQueries = {
  add: db.prepare(`
    INSERT INTO books (guild_id, title, author, cover_url, description, source_url, total_pages, added_by)
    VALUES (@guild_id, @title, @author, @cover_url, @description, @source_url, @total_pages, @added_by)
  `),
  list: db.prepare(`
    SELECT * FROM books WHERE guild_id = ? ORDER BY is_current DESC, added_at DESC
  `),
  get: db.prepare(`SELECT * FROM books WHERE id = ? AND guild_id = ?`),
  remove: db.prepare(`DELETE FROM books WHERE id = ? AND guild_id = ?`),
  setCurrent: db.prepare(`UPDATE books SET is_current = (CASE WHEN id = ? THEN 1 ELSE 0 END) WHERE guild_id = ?`),
  getCurrent: db.prepare(`SELECT * FROM books WHERE guild_id = ? AND is_current = 1 LIMIT 1`),
  updatePages: db.prepare(`UPDATE books SET total_pages = ? WHERE id = ? AND guild_id = ?`),
  search: db.prepare(`SELECT * FROM books WHERE guild_id = ? AND (title LIKE ? OR author LIKE ?) LIMIT 10`),
};

// ─── Polls ────────────────────────────────────────────────────────────────────

const pollQueries = {
  create: db.prepare(`
    INSERT INTO polls (guild_id, channel_id) VALUES (?, ?)
  `),
  setMessageId: db.prepare(`UPDATE polls SET message_id = ? WHERE id = ?`),
  getActive: db.prepare(`SELECT * FROM polls WHERE guild_id = ? AND status = 'active' LIMIT 1`),
  getById: db.prepare(`SELECT * FROM polls WHERE id = ?`),
  getByMessage: db.prepare(`SELECT * FROM polls WHERE message_id = ?`),
  close: db.prepare(`UPDATE polls SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?`),
  addOption: db.prepare(`
    INSERT INTO poll_options (poll_id, book_id, emoji) VALUES (?, ?, ?)
  `),
  getOptions: db.prepare(`
    SELECT po.*, b.title, b.author, b.cover_url 
    FROM poll_options po 
    JOIN books b ON b.id = po.book_id 
    WHERE po.poll_id = ?
    ORDER BY po.emoji
  `),
  updateVotes: db.prepare(`
    UPDATE poll_options SET votes = ? WHERE poll_id = ? AND emoji = ?
  `),
  getOptionByEmoji: db.prepare(`
    SELECT po.*, b.title FROM poll_options po
    JOIN books b ON b.id = po.book_id
    WHERE po.poll_id = ? AND po.emoji = ?
  `),
  getWinner: db.prepare(`
    SELECT po.*, b.title, b.author FROM poll_options po
    JOIN books b ON b.id = po.book_id
    WHERE po.poll_id = ?
    ORDER BY po.votes DESC LIMIT 1
  `),
};

// ─── Progress ─────────────────────────────────────────────────────────────────

const progressQueries = {
  upsert: db.prepare(`
    INSERT INTO progress (guild_id, user_id, book_id, current_page, total_pages, percent, note)
    VALUES (@guild_id, @user_id, @book_id, @current_page, @total_pages, @percent, @note)
    ON CONFLICT(guild_id, user_id, book_id)
    DO UPDATE SET
      current_page = excluded.current_page,
      total_pages  = COALESCE(excluded.total_pages, total_pages),
      percent      = excluded.percent,
      note         = excluded.note,
      updated_at   = CURRENT_TIMESTAMP
  `),
  get: db.prepare(`
    SELECT p.*, b.title, b.author, b.cover_url, b.total_pages as book_total_pages
    FROM progress p JOIN books b ON b.id = p.book_id
    WHERE p.guild_id = ? AND p.user_id = ? AND p.book_id = ?
  `),
  getForBook: db.prepare(`
    SELECT p.*, b.title, b.author
    FROM progress p JOIN books b ON b.id = p.book_id
    WHERE p.guild_id = ? AND p.book_id = ?
    ORDER BY p.percent DESC
  `),
  getUserAll: db.prepare(`
    SELECT p.*, b.title, b.author
    FROM progress p JOIN books b ON b.id = p.book_id
    WHERE p.guild_id = ? AND p.user_id = ?
    ORDER BY p.updated_at DESC
  `),
  log: db.prepare(`
    INSERT INTO progress_log (guild_id, user_id, book_id, percent, note)
    VALUES (?, ?, ?, ?, ?)
  `),
};

// ─── Profiles ─────────────────────────────────────────────────────────────────

const profileQueries = {
  upsert: db.prepare(`
    INSERT INTO profiles (user_id, storygraph_username, goodreads_user_id, goodreads_username)
    VALUES (@user_id, @storygraph_username, @goodreads_user_id, @goodreads_username)
    ON CONFLICT(user_id) DO UPDATE SET
      storygraph_username = COALESCE(excluded.storygraph_username, storygraph_username),
      goodreads_user_id   = COALESCE(excluded.goodreads_user_id, goodreads_user_id),
      goodreads_username  = COALESCE(excluded.goodreads_username, goodreads_username),
      updated_at = CURRENT_TIMESTAMP
  `),
  get: db.prepare(`SELECT * FROM profiles WHERE user_id = ?`),
  clearStorygraph: db.prepare(`UPDATE profiles SET storygraph_username = NULL WHERE user_id = ?`),
  clearGoodreads: db.prepare(`UPDATE profiles SET goodreads_user_id = NULL, goodreads_username = NULL WHERE user_id = ?`),
};

module.exports = {
  db,
  books: bookQueries,
  polls: pollQueries,
  progress: progressQueries,
  profiles: profileQueries,
};

// ─── Ratings ──────────────────────────────────────────────────────────────────

const ratingQueries = {
  upsert: db.prepare(`
    INSERT INTO ratings (guild_id, user_id, book_id, stars, review)
    VALUES (@guild_id, @user_id, @book_id, @stars, @review)
    ON CONFLICT(guild_id, user_id, book_id) DO UPDATE SET
      stars    = excluded.stars,
      review   = excluded.review,
      updated_at = CURRENT_TIMESTAMP
  `),
  get: db.prepare(`SELECT * FROM ratings WHERE guild_id = ? AND user_id = ? AND book_id = ?`),
  getForBook: db.prepare(`
    SELECT r.*, b.title FROM ratings r JOIN books b ON b.id = r.book_id
    WHERE r.guild_id = ? AND r.book_id = ?
    ORDER BY r.updated_at DESC
  `),
  getAverage: db.prepare(`
    SELECT AVG(stars) as avg, COUNT(*) as count FROM ratings
    WHERE guild_id = ? AND book_id = ?
  `),
  getUserAll: db.prepare(`
    SELECT r.*, b.title, b.author FROM ratings r JOIN books b ON b.id = r.book_id
    WHERE r.guild_id = ? AND r.user_id = ?
    ORDER BY r.updated_at DESC
  `),
  delete: db.prepare(`DELETE FROM ratings WHERE guild_id = ? AND user_id = ? AND book_id = ?`),
};

// ─── DNF ──────────────────────────────────────────────────────────────────────

const dnfQueries = {
  upsert: db.prepare(`
    INSERT INTO dnf (guild_id, user_id, book_id, stopped_at_percent, note)
    VALUES (@guild_id, @user_id, @book_id, @stopped_at_percent, @note)
    ON CONFLICT(guild_id, user_id, book_id) DO UPDATE SET
      stopped_at_percent = excluded.stopped_at_percent,
      note               = excluded.note,
      created_at         = CURRENT_TIMESTAMP
  `),
  get: db.prepare(`SELECT * FROM dnf WHERE guild_id = ? AND user_id = ? AND book_id = ?`),
  getForBook: db.prepare(`
    SELECT d.*, b.title FROM dnf d JOIN books b ON b.id = d.book_id
    WHERE d.guild_id = ? AND d.book_id = ?
  `),
  getCountForBook: db.prepare(`SELECT COUNT(*) as count FROM dnf WHERE guild_id = ? AND book_id = ?`),
  delete: db.prepare(`DELETE FROM dnf WHERE guild_id = ? AND user_id = ? AND book_id = ?`),
};

// ─── Content Warnings ─────────────────────────────────────────────────────────

const cwQueries = {
  add: db.prepare(`
    INSERT OR IGNORE INTO content_warnings (book_id, warning, added_by)
    VALUES (?, ?, ?)
  `),
  getForBook: db.prepare(`SELECT * FROM content_warnings WHERE book_id = ? ORDER BY added_at`),
  remove: db.prepare(`DELETE FROM content_warnings WHERE id = ? AND book_id = ?`),
  clearAll: db.prepare(`DELETE FROM content_warnings WHERE book_id = ?`),
};

// ─── Discussion Threads ───────────────────────────────────────────────────────

const threadQueries = {
  add: db.prepare(`
    INSERT INTO discussion_threads (guild_id, book_id, thread_id, milestone_pct, label)
    VALUES (?, ?, ?, ?, ?)
  `),
  getForBook: db.prepare(`
    SELECT * FROM discussion_threads WHERE guild_id = ? AND book_id = ?
    ORDER BY milestone_pct ASC
  `),
  getByThread: db.prepare(`SELECT * FROM discussion_threads WHERE thread_id = ?`),
  clearForBook: db.prepare(`DELETE FROM discussion_threads WHERE guild_id = ? AND book_id = ?`),
};

// patch existing exports
Object.assign(module.exports, {
  ratings: ratingQueries,
  dnf:     dnfQueries,
  cw:      cwQueries,
  threads: threadQueries,
});
