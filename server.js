require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// DB Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Create tables on startup
const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id BIGINT PRIMARY KEY,
      week INT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT NOT NULL,
      task_group TEXT DEFAULT 'ปกติ',
      due_date DATE,
      related TEXT[] DEFAULT '{}',
      pct INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notes (
      id BIGINT PRIMARY KEY,
      task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
      note_date DATE NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS goals (
      id SERIAL PRIMARY KEY,
      week_key TEXT NOT NULL,
      text TEXT NOT NULL,
      done BOOLEAN DEFAULT FALSE
    );
  `);
  console.log('Database tables ready');
};

// ──────────────────────────────────────────
// TASKS API
// ──────────────────────────────────────────

// GET all tasks (optionally filter by week)
app.get('/api/tasks', async (req, res) => {
  const { week } = req.query;
  const result = week
    ? await pool.query('SELECT * FROM tasks WHERE week = $1 ORDER BY created_at', [week])
    : await pool.query('SELECT * FROM tasks ORDER BY week, created_at');
  res.json(result.rows);
});

// POST create task
app.post('/api/tasks', async (req, res) => {
  const { id, week, name, desc, category, group, date, related, pct } = req.body;
  const result = await pool.query(
    `INSERT INTO tasks (id, week, name, description, category, task_group, due_date, related, pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [id, week, name, desc||'', category, group||'ปกติ', date||null, related||[], pct||0]
  );
  res.json(result.rows[0]);
});

// PATCH update task (pct, name, etc.)
app.patch('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const { pct, name, desc, group, date } = req.body;
  const result = await pool.query(
    `UPDATE tasks SET
      pct = COALESCE($1, pct),
      name = COALESCE($2, name),
      description = COALESCE($3, description),
      task_group = COALESCE($4, task_group),
      due_date = COALESCE($5, due_date)
     WHERE id = $6 RETURNING *`,
    [pct ?? null, name||null, desc||null, group||null, date||null, id]
  );
  res.json(result.rows[0]);
});

// DELETE task
app.delete('/api/tasks/:id', async (req, res) => {
  await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ──────────────────────────────────────────
// NOTES API
// ──────────────────────────────────────────

// GET notes by task
app.get('/api/tasks/:taskId/notes', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM notes WHERE task_id = $1 ORDER BY note_date DESC',
    [req.params.taskId]
  );
  res.json(result.rows);
});

// POST create note
app.post('/api/tasks/:taskId/notes', async (req, res) => {
  const { id, date, text } = req.body;
  const result = await pool.query(
    'INSERT INTO notes (id, task_id, note_date, text) VALUES ($1,$2,$3,$4) RETURNING *',
    [id, req.params.taskId, date, text]
  );
  res.json(result.rows[0]);
});

// DELETE note
app.delete('/api/notes/:id', async (req, res) => {
  await pool.query('DELETE FROM notes WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ──────────────────────────────────────────
// GOALS API
// ──────────────────────────────────────────

// GET goals by week key (e.g. w1)
app.get('/api/goals/:weekKey', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM goals WHERE week_key = $1 ORDER BY id',
    [req.params.weekKey]
  );
  res.json(result.rows);
});

// PUT replace all goals for a week
app.put('/api/goals/:weekKey', async (req, res) => {
  const { goals } = req.body; // [{text, done}]
  await pool.query('DELETE FROM goals WHERE week_key = $1', [req.params.weekKey]);
  if (goals && goals.length) {
    const values = goals.map((g, i) => `($${i*3+1}, $${i*3+2}, $${i*3+3})`).join(',');
    const params = goals.flatMap(g => [req.params.weekKey, g.text, g.done]);
    await pool.query(`INSERT INTO goals (week_key, text, done) VALUES ${values}`, params);
  }
  const result = await pool.query('SELECT * FROM goals WHERE week_key = $1 ORDER BY id', [req.params.weekKey]);
  res.json(result.rows);
});

// PATCH toggle goal done
app.patch('/api/goals/:id/toggle', async (req, res) => {
  const result = await pool.query(
    'UPDATE goals SET done = NOT done WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  res.json(result.rows[0]);
});

// ──────────────────────────────────────────
// SYNC API (bulk load all data on startup)
// ──────────────────────────────────────────
app.get('/api/sync', async (req, res) => {
  const tasksRes = await pool.query('SELECT * FROM tasks ORDER BY week, created_at');
  const notesRes = await pool.query('SELECT * FROM notes ORDER BY note_date');
  const goalsRes = await pool.query('SELECT * FROM goals ORDER BY id');

  // Group notes by task_id
  const notesByTask = {};
  notesRes.rows.forEach(n => {
    if (!notesByTask[n.task_id]) notesByTask[n.task_id] = [];
    notesByTask[n.task_id].push({ id: Number(n.id), date: n.note_date?.toISOString().slice(0,10), text: n.text });
  });

  // Group goals by week_key
  const goalsByWeek = {};
  goalsRes.rows.forEach(g => {
    if (!goalsByWeek[g.week_key]) goalsByWeek[g.week_key] = [];
    goalsByWeek[g.week_key].push({ id: g.id, text: g.text, done: g.done });
  });

  // Build tasks with notes
  const tasks = tasksRes.rows.map(t => ({
    id: Number(t.id),
    week: t.week,
    name: t.name,
    desc: t.description,
    category: t.category,
    group: t.task_group,
    date: t.due_date?.toISOString().slice(0,10) || '',
    related: t.related || [],
    pct: t.pct || 0,
    notes: notesByTask[t.id] || [],
  }));

  res.json({ tasks, goals: goalsByWeek });
});

// Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});
