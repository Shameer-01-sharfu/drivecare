# DriveCare — Vehicle Service Center App

A full-stack vehicle service booking system: a **customer app** (PWA) and an **admin dashboard**, backed by a small Node.js / Express server.

## Features

**Customer app** (`/`)
- Register / login, light & dark theme, installable PWA
- 7 services with a price list (General, Oil Change, Brake, AC, Tyre & Alignment, Wash & Detailing, Damage / Replacement)
- Appointment booking with **live time-slot availability** (max 3 bookings per slot)
- **Multiple bookings per customer** — an "Active bookings" list lets you track or resume any of them
- Live status tracker, notifications, **cancel booking** (until the vehicle is received)
- Bill with 18 % GST, UPI / card / cash payment request
- **PDF invoice** download (shop details + invoice number), print and share
- Delivery choice, rating & feedback (sent to the workshop)

**Admin dashboard** (`/admin`)
- **Password login** (JWT, 8 hours)
- **Revenue dashboard**: today's bookings, open jobs, pending payments, revenue today / total, average rating, 7-day revenue chart
- **Search and filters**: name, vehicle no, phone, ticket, service · stage · payment · active/cancelled
- Update job stage, add / remove parts and services, confirm payments (issues the invoice number)
- See customer **ratings and feedback**, delivery choice
- Delete bookings

**Server**
- helmet, rate limiting (login is limited to 10 wrong attempts / 15 min), input validation
- Only the app files are public — `bookings.json` and `server.js` can no longer be downloaded
- All user-provided text is HTML-escaped (XSS fix)
- `PORT` from the environment (ready for Render)

## Run it

```bash
npm install
cp .env.example .env     # Windows PowerShell: copy .env.example .env   — then edit ADMIN_PASSWORD
npm start
```

Open `http://localhost:3000` (customer) and `http://localhost:3000/admin` (admin).
If you skip the `.env` file the admin password is `admin123` — change it before sharing the app.

## Configuration (`.env`)

| Variable | Meaning | Default |
|---|---|---|
| `ADMIN_PASSWORD` | Admin dashboard password | `admin123` |
| `JWT_SECRET` | Signs admin login tokens | random per start |
| `PORT` | Server port | `3000` |
| `MAX_PER_SLOT` | Bookings per date + time slot | `3` |
| `MAX_OPEN_PER_PHONE` | Open bookings one customer may hold | `5` |
| `DB_FILE` | Where bookings are stored | `./bookings.json` |
| `TIMEZONE` | Used for "today" and invoice dates | `Asia/Kolkata` |

Edit the shop name, address, phone and GSTIN printed on the invoice at the top of the `<script>` in `index.html` (`const SHOP = {...}`).

Old `bookings.json` files (keyed by phone number) are converted automatically on first start.

## API (short)

Public: `GET /api/services`, `GET /api/slots?date=`, `POST /api/booking`, `GET /api/booking/:id?phone=`, `GET /api/bookings/by-phone/:phone`, `POST /api/booking/:id/{payment,cancel,delivery,feedback}`
Admin (Bearer token): `POST /api/admin/login`, `GET /api/bookings`, `POST /api/booking/:id/{stage,items,items/remove,confirm-payment}`, `DELETE /api/booking/:id`

## Known limitations / next steps

- Customer accounts (and passwords) still live in the browser's storage. Next step: server-side register / login with hashed passwords (bcryptjs).
- Bookings are stored in a JSON file. Render's free disk is wiped on restart — use a persistent disk (`DB_FILE`) or move to MongoDB.
- The UPI QR is a placeholder; payments are confirmed manually by the admin. Razorpay would be the next integration.
- The PDF library (jsPDF) is loaded from cdnjs the first time; offline it falls back to the print dialog.
