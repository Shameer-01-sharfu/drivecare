'use strict';
/* =====================================================================
   DriveCare server  (Express + JSON-file database)

   What's new in v2
   - Admin login (password + JWT) — every admin API now needs a token
   - Bookings are stored by ticket id, so one customer can have many bookings
   - Time-slot limit (MAX_PER_SLOT bookings per date + time)
   - Cancel booking (customer) / delete booking (admin)
   - Feedback + delivery preference are saved on the server
   - Service catalogue with fixed prices (/api/services)
   - Invoice numbers + paid amount stored when payment is confirmed
   - helmet, rate limiting, input validation, PORT from environment
   ===================================================================== */

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

/* ---------- config (set these in a .env file or in the host's environment) ---------- */
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (e) { /* no .env file — that's fine */ }
}
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'bookings.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const USING_DEFAULT_PASSWORD = !process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const MAX_PER_SLOT = Number(process.env.MAX_PER_SLOT) || 3;
const MAX_OPEN_PER_PHONE = Number(process.env.MAX_OPEN_PER_PHONE) || 5;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';
const GST_RATE = 0.18;
const SUPER_PASSWORD = process.env.SUPER_PASSWORD || 'super123';

const SLOT_TIMES = ['9:00 AM', '10:30 AM', '12:00 PM', '2:00 PM', '4:00 PM'];
const PAYMENT_METHODS = ['UPI', 'Card', 'Cash'];

/* ---------- service catalogue (the customer app loads this from /api/services) ---------- */
const SERVICES = [
  { key: 'general', name: 'General Service',  icon: '🔧', fixed: true,  base: 1200, labour: 350,
    desc: 'Routine maintenance — oil change, filters, brake check, inspection and tune-up.' },
  { key: 'oil',     name: 'Oil Change',       icon: '🛢️', fixed: true,  base: 800,  labour: 200,
    desc: 'Engine oil and oil filter replacement with a quick health check.' },
  { key: 'brake',   name: 'Brake Service',    icon: '🛑', fixed: true,  base: 1800, labour: 500,
    desc: 'Brake pad inspection, cleaning and adjustment. Extra parts are billed separately.' },
  { key: 'ac',      name: 'AC Service',       icon: '❄️', fixed: true,  base: 1500, labour: 400,
    desc: 'Gas top-up, filter cleaning and cooling performance check.' },
  { key: 'tyre',    name: 'Tyre & Alignment', icon: '🛞', fixed: true,  base: 1000, labour: 300,
    desc: 'Wheel alignment, balancing and tyre rotation.' },
  { key: 'wash',    name: 'Wash & Detailing', icon: '🚿', fixed: true,  base: 500,  labour: 150,
    desc: 'Exterior wash, interior vacuum and polish.' },
  { key: 'damage',  name: 'Damage / Replacement', icon: '⚠️', fixed: false, base: 0, labour: 0,
    desc: 'Something is broken, worn out, or needs a part replaced. Quote is prepared after inspection.' }
];
function findService(x) {
  return SERVICES.find(s => s.key === x || s.name === x) || null;
}

/* ---------- tiny JSON-file database ----------
   Shape: { version: 2, invoiceSeq: 0, bookings: { "<ticket id>": {...booking} } }
   Old v1 files (an object keyed by phone number) are converted automatically. */
function emptyDb() { return { version: 2, invoiceSeq: 0, bookings: {} }; }

function newId(db) {
  let id;
  do { id = 'TB' + crypto.randomInt(100000, 1000000); } while (Object.prototype.hasOwnProperty.call(db.bookings, id));
  return id;
}

function migrate(raw) {
  if (raw && raw.version === 2 && raw.bookings && typeof raw.bookings === 'object') {
    raw.invoiceSeq = Number(raw.invoiceSeq) || 0;
    return raw;
  }
  const db = emptyDb();
  Object.values(raw || {}).forEach(b => {
    if (!b || typeof b !== 'object' || !b.phone) return;
    const id = (typeof b.id === 'string' && /^[A-Za-z0-9_-]{3,20}$/.test(b.id) && !db.bookings[b.id]) ? b.id : newId(db);
    b.id = id;
    b.status = b.status || 'active';
    b.paymentStatus = b.paymentStatus || 'unpaid';
    if (!Array.isArray(b.items)) b.items = [];
    if (!b.serviceKey) { const s = findService(b.serviceType); if (s) b.serviceKey = s.key; }
    if (b.paymentStatus === 'confirmed' && b.rating) b.closed = true;
    db.bookings[id] = b;
  });
  return db;
}

function readFileDB() {
  let text;
  try {
    text = fs.readFileSync(DB_FILE, 'utf8');
  } catch (e) {
    return emptyDb();                       // no file yet
  }
  try {
    return migrate(JSON.parse(text));
  } catch (e) {
    const backup = DB_FILE + '.corrupt-' + Date.now();
    try { fs.copyFileSync(DB_FILE, backup); } catch (_) { /* ignore */ }
    console.error('bookings file was unreadable — copied to', backup, 'and started a new one');
    return emptyDb();
  }
}

function writeFileDB(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);              // atomic swap, so a crash can't leave half a file
}

/* ---------- storage: MongoDB Atlas when MONGODB_URI is set, otherwise the JSON file ----------
   In Mongo mode the database lives in memory and is saved to Atlas (one document) after every change. */
const MONGODB_URI = process.env.MONGODB_URI || '';
let mongoCol = null;
let cache = null;
let saveChain = Promise.resolve();

async function initStorage() {
  if (!MONGODB_URI) { console.log('Storage: JSON file (' + DB_FILE + ') - set MONGODB_URI to use MongoDB Atlas'); return; }
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  mongoCol = client.db(process.env.MONGODB_DB || 'drivecare').collection('state');
  const doc = await mongoCol.findOne({ _id: 'main' });
  if (doc) { delete doc._id; cache = migrate(doc); }
  else {                                     // first run: import bookings.json if there is one
    cache = readFileDB();
    await mongoCol.replaceOne({ _id: 'main' }, { _id: 'main', ...cache }, { upsert: true });
  }
  console.log('Storage: MongoDB Atlas');
}
function readDB() {                          // always a copy, so a half-finished request never changes stored data
  return mongoCol ? JSON.parse(JSON.stringify(cache)) : readFileDB();
}
function writeDB(db) {
  if (!mongoCol) return writeFileDB(db);
  cache = db;
  const snapshot = { _id: 'main', ...JSON.parse(JSON.stringify(db)) };
  saveChain = saveChain
    .then(() => mongoCol.replaceOne({ _id: 'main' }, snapshot, { upsert: true }))
    .catch(e => console.error('MongoDB save failed:', e.message));
}

function getBooking(db, id) {
  return Object.prototype.hasOwnProperty.call(db.bookings, id) ? db.bookings[id] : null;
}

/* ---------- helpers ---------- */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });
const PHONE_RE = /^\d{10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD
}
function validDate(d) {
  return DATE_RE.test(d) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
}

/* The bill. Same maths as the customer app: itemised if the workshop added items,
   otherwise the fixed price of the service (damage jobs have no fixed price). */
function billFor(b) {
  const items = Array.isArray(b.items) ? b.items : [];
  let subtotal = 0;
  let needsItems = false;
  if (items.length) {
    subtotal = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  } else {
    const svc = findService(b.serviceKey || b.serviceType);
    if (svc && svc.fixed) subtotal = svc.base + svc.labour;
    else needsItems = true;
  }
  const gst = Math.round(subtotal * GST_RATE);
  return { subtotal, gst, total: subtotal + gst, needsItems };
}
const publicBooking = b => ({ ...b, bill: billFor(b) });

/* parts on a booking are taken from stock when added; they go back if the booking is cancelled / deleted unpaid */
function releaseParts(db, b) {
  if (b.partsReleased) return;
  (b.items || []).forEach(i => {
    const p = i.partId && (db.parts || []).find(x => x.id === i.partId);
    if (p) p.stock += 1;
  });
  b.partsReleased = true;
}

/* ---------- app + security middleware ---------- */
const app = express();
app.set('trust proxy', 1);                  // Render / most hosts sit behind one proxy
app.use(helmet({ contentSecurityPolicy: false })); // CSP off: the pages use inline scripts + Google Fonts
app.use(express.json({ limit: '50kb' }));

app.use('/api', rateLimit({
  windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — slow down a little.' }
}));
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true,             // only wrong passwords count towards the limit
  message: { error: 'Too many login attempts. Try again in 15 minutes.' }
});

/* ---------- static files: ONLY the app files are public (not bookings.json / server.js) ---------- */
const sendFile = f => (req, res) => res.sendFile(path.join(__dirname, f));
app.get(['/', '/index.html'], sendFile('index.html'));
app.get(['/admin', '/admin.html'], sendFile('admin.html'));
app.get(['/manage', '/manage.html'], sendFile('manage.html'));
app.get('/sw.js', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'sw.js')); });
app.get('/manifest.json', sendFile('manifest.json'));
app.use('/icons', express.static(path.join(__dirname, 'icons')));

/* ---------- admin auth ---------- */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const pw = req.body && req.body.password;
  const role = typeof pw !== 'string' ? null : safeEqual(pw, SUPER_PASSWORD) ? 'super' : safeEqual(pw, ADMIN_PASSWORD) ? 'admin' : null;
  if (!role) return bad(res, 'Wrong password', 401);
  const token = jwt.sign({ role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, role, expiresInHours: 8 });
});

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return bad(res, 'Admin login required', 401);
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (payload.role !== 'admin' && payload.role !== 'super') throw new Error('bad role');
    req.role = payload.role;
    next();
  } catch (e) {
    bad(res, 'Session expired — please log in again', 401);
  }
}

/* =====================================================================
   PUBLIC / CUSTOMER API
   (Customer accounts still live in the browser — see README "Next steps".
    As a light safeguard, customer routes need the booking's phone number too.)
   ===================================================================== */

app.get('/api/services', (req, res) => res.json({ services: SERVICES, gstRate: GST_RATE }));

/* Which time slots are still free on a date? */
app.get('/api/slots', (req, res) => {
  const date = str(req.query.date, 10);
  if (!validDate(date)) return bad(res, 'date must be YYYY-MM-DD');
  const counts = {};
  Object.values(readDB().bookings).forEach(b => {
    if (b.date === date && b.status !== 'cancelled') counts[b.time] = (counts[b.time] || 0) + 1;
  });
  res.json({
    date,
    max: MAX_PER_SLOT,
    slots: SLOT_TIMES.map(t => ({
      time: t,
      booked: counts[t] || 0,
      available: Math.max(0, MAX_PER_SLOT - (counts[t] || 0))
    }))
  });
});

/* Create a booking (one customer can have many) */
app.post('/api/booking', (req, res) => {
  const body = req.body || {};
  const phone = str(body.phone, 10);
  const name = str(body.name, 60);
  const vehicleNo = str(body.vehicleNo, 20).toUpperCase();
  const vehicleModel = str(body.vehicleModel, 40);
  const svc = findService(str(body.serviceKey, 40));
  const date = str(body.date, 10);
  const time = str(body.time, 12);
  const dropMode = body.dropMode;
  const pickupAddr = str(body.pickupAddr, 250);

  if (!PHONE_RE.test(phone)) return bad(res, 'A valid 10-digit phone number is required');
  if (!name) return bad(res, 'Name is required');
  if (!vehicleNo) return bad(res, 'Vehicle number is required');
  if (!svc) return bad(res, 'Please choose a valid service');
  if (!validDate(date)) return bad(res, 'Please choose a valid date');
  if (date < todayStr()) return bad(res, 'Please choose today or a future date');
  if (!SLOT_TIMES.includes(time)) return bad(res, 'Please choose a valid time slot');
  if (dropMode !== 'self' && dropMode !== 'driver') return bad(res, 'Please choose how the vehicle will reach us');
  if (dropMode === 'driver' && !pickupAddr) return bad(res, 'Pickup address is required for driver pickup');

  const db = readDB();
  const all = Object.values(db.bookings);

  const taken = all.filter(b => b.date === date && b.time === time && b.status !== 'cancelled').length;
  if (taken >= MAX_PER_SLOT) {
    return res.status(409).json({ error: 'That time slot is full. Please pick another time.', code: 'slot_full' });
  }
  const open = all.filter(b => b.phone === phone && b.status !== 'cancelled' && !b.closed).length;
  if (open >= MAX_OPEN_PER_PHONE) {
    return bad(res, `You already have ${open} open bookings. Finish or cancel one first.`, 429);
  }

  // Damage / Replacement: the parts the customer picked become bill items (price from the catalogue)
  const items = [];
  if (svc.key === 'damage' && Array.isArray(body.partIds)) {
    for (const pid of [...new Set(body.partIds.map(String))].slice(0, 20)) {
      const part = (db.parts || []).find(x => x.id === pid);
      if (!part) return bad(res, 'One of the selected parts no longer exists');
      if (part.stock < 1) return bad(res, part.name + ' is out of stock');
      part.stock -= 1;                       // reserved for this job
      items.push({ name: part.name, amount: part.price, type: 'part', partId: part.id });
    }
  }
  const now = Date.now();
  const booking = {
    id: newId(db),
    phone, name, vehicleNo, vehicleModel,
    serviceKey: svc.key, serviceType: svc.name,
    date, time, dropMode,
    pickupAddr: dropMode === 'driver' ? pickupAddr : null,
    stage: 0,
    status: 'active',
    items,
    paymentStatus: 'unpaid',
    createdAt: now,
    updatedAt: now
  };
  db.bookings[booking.id] = booking;
  writeDB(db);
  res.status(201).json(publicBooking(booking));
});

/* Look up one booking (customer app polls this) */
function loadOwned(req, res) {
  const db = readDB();
  const b = getBooking(db, req.params.id);
  const phone = str((req.body && req.body.phone) || req.query.phone, 10);
  if (!b || b.phone !== phone) { bad(res, 'Booking not found', 404); return null; }
  return { db, b };
}

app.get('/api/booking/:id', (req, res) => {
  const o = loadOwned(req, res); if (!o) return;
  res.json(publicBooking(o.b));
});

/* All bookings of one customer (history + "active bookings") */
app.get('/api/bookings/by-phone/:phone', (req, res) => {
  const phone = str(req.params.phone, 10);
  if (!PHONE_RE.test(phone)) return bad(res, 'Invalid phone number');
  const list = Object.values(readDB().bookings)
    .filter(b => b.phone === phone)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(publicBooking);
  res.json(list);
});

/* Customer: cancel — only before the vehicle is received */
app.post('/api/booking/:id/cancel', (req, res) => {
  const o = loadOwned(req, res); if (!o) return;
  const { db, b } = o;
  if (b.status === 'cancelled') return res.json(publicBooking(b));
  if ((b.stage || 0) > 0 || (b.paymentStatus || 'unpaid') !== 'unpaid') {
    return bad(res, 'The vehicle has already been received — please call the workshop to cancel.', 409);
  }
  releaseParts(db, b);
  b.status = 'cancelled';
  b.cancelledAt = Date.now();
  b.updatedAt = Date.now();
  writeDB(db);
  res.json(publicBooking(b));
});

/* Customer: "I've paid" — goes into the pending queue for the shop to confirm */
app.post('/api/booking/:id/payment', (req, res) => {
  const o = loadOwned(req, res); if (!o) return;
  const { db, b } = o;
  const method = req.body && req.body.method;
  if (!PAYMENT_METHODS.includes(method)) return bad(res, 'Choose UPI, Card or Cash');
  if (b.status === 'cancelled') return bad(res, 'This booking was cancelled', 409);
  if (b.paymentStatus === 'confirmed') return bad(res, 'This booking is already paid', 409);
  if (billFor(b).needsItems) return bad(res, 'The bill is not ready yet', 409);
  if (method === 'Card') {                   // only the last 4 digits + name are ever accepted
    const last4 = str(req.body.cardLast4, 4), holder = str(req.body.cardHolder, 60);
    if (!/^\d{4}$/.test(last4) || !holder) return bad(res, 'Card details are required');
    b.cardLast4 = last4; b.cardHolder = holder;
  }
  b.paymentMethod = method;
  b.paymentStatus = 'pending';
  b.updatedAt = Date.now();
  writeDB(db);
  res.json(publicBooking(b));
});

/* Customer: how the vehicle should come back */
app.post('/api/booking/:id/delivery', (req, res) => {
  const o = loadOwned(req, res); if (!o) return;
  const { db, b } = o;
  const mode = req.body && req.body.mode;
  const addr = str(req.body && req.body.addr, 250);
  if (mode !== 'self' && mode !== 'driver') return bad(res, 'Choose self pickup or driver delivery');
  if (mode === 'driver' && !addr) return bad(res, 'Delivery address is required');
  b.deliveryMode = mode;
  b.deliveryAddr = mode === 'driver' ? addr : null;
  b.updatedAt = Date.now();
  writeDB(db);
  res.json(publicBooking(b));
});

/* Customer: rating + comment (saved on the server so the admin can see it) */
app.post('/api/booking/:id/feedback', (req, res) => {
  const o = loadOwned(req, res); if (!o) return;
  const { db, b } = o;
  const rating = Number(req.body && req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return bad(res, 'Rating must be 1 to 5');
  if (b.paymentStatus !== 'confirmed') return bad(res, 'You can rate after the payment is confirmed', 409);
  b.rating = rating;
  b.feedback = str(req.body && req.body.feedback, 500);
  b.feedbackAt = Date.now();
  b.closed = true;
  b.updatedAt = Date.now();
  writeDB(db);
  res.json(publicBooking(b));
});

/* =====================================================================
   ADMIN API  (all need  Authorization: Bearer <token>)
   ===================================================================== */

app.get('/api/bookings', requireAdmin, (req, res) => {
  res.json(Object.values(readDB().bookings).map(publicBooking));
});

function loadAdminBooking(req, res) {
  const db = readDB();
  const b = getBooking(db, req.params.id);
  if (!b) { bad(res, 'Booking not found', 404); return null; }
  return { db, b };
}

app.post('/api/booking/:id/stage', requireAdmin, (req, res) => {
  const o = loadAdminBooking(req, res); if (!o) return;
  const { db, b } = o;
  const stage = Number(req.body && req.body.stage);
  if (!Number.isInteger(stage)) return bad(res, 'stage must be a number');
  if (b.status === 'cancelled') return bad(res, 'This booking was cancelled', 409);
  b.stage = Math.max(0, Math.min(3, stage));
  b.updatedAt = Date.now();
  writeDB(db);
  res.json(publicBooking(b));
});

app.post('/api/booking/:id/items', requireAdmin, (req, res) => {
  const o = loadAdminBooking(req, res); if (!o) return;
  const { db, b } = o;
  const name = str(req.body && req.body.name, 80);
  const amount = Number(req.body && req.body.amount);
  const type = req.body && req.body.type === 'part' ? 'part' : 'service';
  if (!name) return bad(res, 'Item name is required');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return bad(res, 'Amount must be between 1 and 10,00,000');
  if (b.status === 'cancelled') return bad(res, 'This booking was cancelled', 409);
  if (b.paymentStatus === 'confirmed') return bad(res, 'This bill is already paid and cannot be changed', 409);
  b.items = Array.isArray(b.items) ? b.items : [];
  if (b.items.length >= 50) return bad(res, 'Too many items on one bill');
  const partId = req.body && req.body.partId;
  const part = partId ? (db.parts || []).find(x => x.id === partId) : null;
  if (partId && !part) return bad(res, 'Part not found', 404);
  if (part) {
    if (part.stock < 1) return bad(res, part.name + ' is out of stock', 409);
    part.stock -= 1;                         // part used -> stock goes down automatically
  }
  b.items.push(part
    ? { name: part.name, amount: part.price, type: 'part', partId: part.id }
    : { name, amount: Math.round(amount * 100) / 100, type });
  b.updatedAt = Date.now();
  writeDB(db);
  res.json(publicBooking(b));
});

app.post('/api/booking/:id/items/remove', requireAdmin, (req, res) => {
  const o = loadAdminBooking(req, res); if (!o) return;
  const { db, b } = o;
  const index = Number(req.body && req.body.index);
  if (b.paymentStatus === 'confirmed') return bad(res, 'This bill is already paid and cannot be changed', 409);
  if (Array.isArray(b.items) && Number.isInteger(index) && index >= 0 && index < b.items.length) {
    const [removed] = b.items.splice(index, 1);
    const part = removed && removed.partId && (db.parts || []).find(x => x.id === removed.partId);
    if (part) part.stock += 1;               // removed from the bill -> back in stock
  }
  b.updatedAt = Date.now();
  writeDB(db);
  res.json(publicBooking(b));
});

/* Confirming the payment is what "issues" the invoice / receipt */
app.post('/api/booking/:id/confirm-payment', requireAdmin, (req, res) => {
  const o = loadAdminBooking(req, res); if (!o) return;
  const { db, b } = o;
  if (b.paymentStatus === 'confirmed') return res.json(publicBooking(b));
  if (b.paymentStatus !== 'pending') return bad(res, 'The customer has not requested payment yet', 409);
  const bill = billFor(b);
  if (bill.needsItems) return bad(res, 'Add the bill items first', 409);
  db.invoiceSeq += 1;
  b.paymentStatus = 'confirmed';
  b.paidAmount = bill.total;
  b.invoiceNo = `INV-${todayStr().slice(0, 4)}-${String(db.invoiceSeq).padStart(4, '0')}`;
  b.receiptNo = b.receiptNo || ('RCPT-' + b.id);
  b.paidAt = new Date().toLocaleString('en-IN', { timeZone: TIMEZONE });
  b.paidAtTs = Date.now();
  b.updatedAt = Date.now();
  writeDB(db);
  res.json(publicBooking(b));
});

app.delete('/api/booking/:id', requireAdmin, (req, res) => {
  const o = loadAdminBooking(req, res); if (!o) return;
  if (o.b.paymentStatus !== 'confirmed') releaseParts(o.db, o.b);
  delete o.db.bookings[req.params.id];
  writeDB(o.db);
  res.json({ deleted: true, id: req.params.id });
});

require('./inventory')(app, { readDB, writeDB, requireAdmin, bad, str, todayStr, TIMEZONE });

/* ---------- fallbacks ---------- */
app.use('/api', (req, res) => bad(res, 'Not found', 404));
app.use((err, req, res, next) => {          // bad JSON etc.
  if (res.headersSent) return next(err);
  const code = err.status || err.statusCode || 500;
  if (code >= 500) console.error(err);
  res.status(code).json({ error: code >= 500 ? 'Server error' : 'Bad request' });
});

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

initStorage().then(() => app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIp();
  console.log('\nDriveCare is running!\n');
  console.log(`  Customer app : http://localhost:${PORT}`);
  console.log(`  Admin panel  : http://localhost:${PORT}/admin`);
  console.log(`  On phone     : http://${ip}:${PORT}   (connect phone to the SAME Wi-Fi)\n`);
  if (USING_DEFAULT_PASSWORD) {
    console.log('  ⚠  Admin password is the default "admin123".');
    console.log('     Set ADMIN_PASSWORD in a .env file (see .env.example) before sharing the app.\n');
  }
})).catch(e => { console.error('Could not start the server:', e.message); process.exit(1); });
