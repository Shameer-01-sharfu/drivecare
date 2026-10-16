'use strict';
/* Parts catalogue + stock, workers, attendance, salary and daily turnover.
   Normal admin: parts name/price.  Super admin: everything (stock, workers, attendance, salary, turnover). */
const SEED = [['Brake Pads (set)',1800,12],['Headlight Assembly',2500,6],['Side Mirror',1200,10],['Front Bumper',4500,4],
  ['Windshield Glass',6500,3],['Car Battery',5200,8],['Clutch Plate',3200,5],['Tyre (each)',3800,16]]
  .map((x, i) => ({ id: 'P' + (i + 1), name: x[0], price: x[1], stock: x[2] }));

module.exports = function (app, { readDB, writeDB, requireAdmin, bad, str, todayStr, TIMEZONE }) {
  const superOnly = (req, res, next) => (req.role === 'super' ? next() : bad(res, 'Super admin only', 403));
  const S = [requireAdmin, superOnly];
  const uid = p => p + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  const load = () => {
    const db = readDB(); let dirty = false;
    if (!db.parts) { db.parts = SEED.map(p => ({ ...p })); dirty = true; }
    db.workers = db.workers || []; db.attendance = db.attendance || {}; db.salaryPaid = db.salaryPaid || [];
    if (dirty) writeDB(db);
    return db;
  };

  /* ----- parts (customers read the list when booking a Damage / Replacement job) ----- */
  app.get('/api/parts', (req, res) => res.json(load().parts));
  app.post('/api/parts', requireAdmin, (req, res) => {
    const db = load(), name = str(req.body.name, 80), price = Number(req.body.price);
    if (!name || !(price > 0)) return bad(res, 'Name and a price above 0 are required');
    const stock = req.role === 'super' ? Math.max(0, parseInt(req.body.stock) || 0) : 0;
    const p = { id: uid('P'), name, price: Math.round(price), stock };
    db.parts.push(p); writeDB(db); res.status(201).json(p);
  });
  app.put('/api/parts/:id', requireAdmin, (req, res) => {
    const db = load(), p = db.parts.find(x => x.id === req.params.id);
    if (!p) return bad(res, 'Part not found', 404);
    if (req.body.name !== undefined) p.name = str(req.body.name, 80) || p.name;
    if (Number(req.body.price) > 0) p.price = Math.round(Number(req.body.price));
    if (req.role === 'super' && Number.isInteger(parseInt(req.body.stock))) p.stock = Math.max(0, parseInt(req.body.stock));
    writeDB(db); res.json(p);
  });
  app.post('/api/parts/:id/stock', S, (req, res) => {
    const db = load(), p = db.parts.find(x => x.id === req.params.id), add = parseInt(req.body.add);
    if (!p) return bad(res, 'Part not found', 404);
    if (!Number.isInteger(add) || add === 0 || Math.abs(add) > 10000) return bad(res, 'Enter a stock change');
    p.stock = Math.max(0, p.stock + add); writeDB(db); res.json(p);
  });
  app.delete('/api/parts/:id', requireAdmin, (req, res) => {
    const db = load(); db.parts = db.parts.filter(x => x.id !== req.params.id); writeDB(db); res.json({ deleted: true });
  });

  /* ----- workers ----- */
  app.get('/api/super/workers', S, (req, res) => res.json(load().workers));
  app.post('/api/super/workers', S, (req, res) => {
    const db = load(), name = str(req.body.name, 60), salary = Number(req.body.salary);
    if (!name || !(salary >= 0)) return bad(res, 'Name and monthly salary are required');
    const w = { id: uid('W'), name, phone: str(req.body.phone, 15), role: str(req.body.role, 40) || 'Mechanic', salary: Math.round(salary), joined: todayStr() };
    db.workers.push(w); writeDB(db); res.status(201).json(w);
  });
  app.delete('/api/super/workers/:id', S, (req, res) => {
    const db = load(); db.workers = db.workers.filter(w => w.id !== req.params.id); writeDB(db); res.json({ deleted: true });
  });

  /* ----- attendance: P = present, H = half day, A = absent ----- */
  app.get('/api/super/attendance', S, (req, res) => res.json(load().attendance[str(req.query.date, 10)] || {}));
  app.post('/api/super/attendance', S, (req, res) => {
    const db = load(), { workerId, date, status } = req.body || {};
    if (!db.workers.some(w => w.id === workerId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !['P', 'H', 'A'].includes(status)) return bad(res, 'Invalid attendance entry');
    (db.attendance[date] = db.attendance[date] || {})[workerId] = status;
    writeDB(db); res.json(db.attendance[date]);
  });

  /* ----- salary: monthly salary / 30 x (present + half/2) ----- */
  app.get('/api/super/salary', S, (req, res) => {
    const db = load(), m = str(req.query.month, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) return bad(res, 'month must be YYYY-MM');
    res.json(db.workers.map(w => {
      let P = 0, H = 0;
      Object.keys(db.attendance).filter(d => d.startsWith(m)).forEach(d => { const s = db.attendance[d][w.id]; if (s === 'P') P++; if (s === 'H') H++; });
      const due = Math.round(w.salary / 30 * (P + H / 2));
      const paid = db.salaryPaid.filter(x => x.workerId === w.id && x.month === m).reduce((t, x) => t + x.amount, 0);
      return { workerId: w.id, name: w.name, salary: w.salary, present: P, half: H, due, paid, balance: due - paid };
    }));
  });
  app.post('/api/super/salary/pay', S, (req, res) => {
    const db = load(), { workerId, month } = req.body || {}, amount = Math.round(Number(req.body.amount));
    if (!db.workers.some(w => w.id === workerId) || !/^\d{4}-\d{2}$/.test(month) || !(amount > 0)) return bad(res, 'Invalid salary payment');
    db.salaryPaid.push({ workerId, month, amount, paidAt: todayStr() }); writeDB(db); res.json({ ok: true });
  });

  /* ----- daily turnover = confirmed payments per day ----- */
  app.get('/api/super/turnover', S, (req, res) => {
    const days = {};
    Object.values(readDB().bookings).forEach(b => {
      if (b.paymentStatus !== 'confirmed' || !b.paidAtTs) return;
      const d = new Date(b.paidAtTs).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
      const x = days[d] = days[d] || { date: d, invoices: 0, turnover: 0 };
      x.invoices++; x.turnover += b.paidAmount || 0;
    });
    res.json({ today: todayStr(), days: Object.values(days).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30) });
  });
};
