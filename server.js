// ----------------------------------------------------
// Imports & Setup
// ----------------------------------------------------
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const crypto = require("crypto");
const sendgrid = require("@sendgrid/mail");
const cron = require("node-cron");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ----------------------------------------------------
// Canonical public API base URL (HTTPS only)
// ----------------------------------------------------
const PUBLIC_API_BASE = "https://api.equinetransportuk.com";


const app = express();

// ----------------------------------------------------
// Redirect /pay/:bookingID to Wix deposit page
// ----------------------------------------------------
app.get("/pay/:bookingID", (req, res) => {
  const bookingID = req.params.bookingID;
  const target = `https://www.equinetransportuk.com/deposit?bookingID=${bookingID}`;
  return res.redirect(target);
});

// Serve static (Thank-you embed assets if needed)
app.use(express.static("public"));

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
sendgrid.setApiKey(process.env.SENDGRID_API_KEY);


// ----------------------------------------------------
// ⚠️ DATE FORMATTER (dd/mm/yy) — ADDED
// ----------------------------------------------------
function formatDateLondon(dateString) {
  if (!dateString) return "";
  const d = new Date(dateString.replace(" ", "T"));
  if (isNaN(d)) return dateString;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
  return `${dd}/${mm}/${yy} ${time}`;
}

// IMPORTANT ⚠️
// Stripe Webhook requires raw body. JSON middleware comes AFTER this.
// ----------------------------------------------------
// Stripe Webhook (raw body required)
// ----------------------------------------------------
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const obj = event.data.object;

    try {
      switch (event.type) {
        case "payment_intent.succeeded":
          console.log("✅ payment_intent.succeeded:", obj.id);
          break;

        case "payment_intent.payment_failed":
          console.log("❌ payment_intent.payment_failed:", obj.id);
          break;

        case "payment_intent.canceled":
          console.log("⚠️ payment_intent.canceled:", obj.id);
          // When a deposit is canceled, attempt to notify customer + admin
          if (obj.metadata?.bookingID) {
            const bookingID = obj.metadata.bookingID;
            const booking = await fetchPlanyoBooking(bookingID);
            if (booking.email) {
              const html = emailTemplate({
                title: "Deposit Hold Canceled",
                color: "#d9534f",
                bodyTop: `The deposit hold for <b>Booking #${bookingID}</b> has been <b>canceled</b>.`,
                bookingID,
                booking,
              });

              await Promise.all([
                sendgrid.send({
                  to: booking.email,
                  from: "Equine Transport UK <info@equinetransportuk.com>",
                  subject: `Equine Transport UK | Deposit Hold Canceled | Booking #${bookingID}`,
                  html,
                }),
                sendgrid.send({
                  to: "kverhagen@mac.com",
                  from: "Equine Transport UK <info@equinetransportuk.com>",
                  subject: `Admin Copy | Deposit Hold Canceled | Booking #${bookingID}`,
                  html,
                }),
              ]);
            }
          }
          break;

        case "charge.refunded":
          console.log("💸 charge.refunded:", obj.id);
          // Use payment_intent metadata to identify booking
          try {
            const pi = await stripe.paymentIntents.retrieve(obj.payment_intent);
            const bookingID = pi?.metadata?.bookingID;
            if (bookingID) {
              const booking = await fetchPlanyoBooking(bookingID);
              if (booking.email) {
                const html = emailTemplate({
                  title: "Deposit Refunded",
                  color: "#28a745",
                  bodyTop: `Your deposit for <b>Booking #${bookingID}</b> has been <b>refunded</b>.`,
                  bookingID,
                  booking,
                });

                await Promise.all([
                  sendgrid.send({
                    to: booking.email,
                    from: "Equine Transport UK <info@equinetransportuk.com>",
                    subject: `Equine Transport UK | Deposit Refunded | Booking #${bookingID}`,
                    html,
                  }),
                  sendgrid.send({
                    to: "kverhagen@mac.com",
                    from: "Equine Transport UK <info@equinetransportuk.com>",
                    subject: `Admin Copy | Deposit Refunded | Booking #${bookingID}`,
                    html,
                  }),
                ]);
              }
            }
          } catch (e) {
            console.error("⚠️ charge.refunded handler error:", e);
          }
          break;

        default:
          console.log(`ℹ️ Unhandled Stripe event: ${event.type}`);
      }

      res.send();
    } catch (err) {
      console.error("❌ Webhook handler error:", err);
      res.status(500).send("Webhook handler error");
    }
  }
);

// ----------------------------------------------------
// Normal middleware AFTER webhook
// ----------------------------------------------------
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));


// ----------------------------------------------------
// ✨ UPDATED emailTemplate — now formats start/end DD/MM/YY
// ----------------------------------------------------
function emailTemplate({ title, color, bodyTop, bookingID, booking }) {
  return `
    <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333;">
      <img src="https://static.wixstatic.com/media/a9ff84_dfc6008558f94e88a3be92ae9c70201b~mv2.webp"
           alt="Equine Transport UK"
           style="width:160px; height:auto; display:block; margin:0 auto 20px auto;" />
      <h2 style="text-align:center; color:${color};">${title}</h2>
      <p>${bodyTop}</p>
      <h3>Booking Details</h3>
      <ul>
        <li><b>Booking:</b> #${bookingID}</li>
        <li><b>Lorry:</b> ${booking.resource}</li>
        <li><b>From:</b> ${formatDateLondon(booking.start)}</li>
        <li><b>To:</b> ${formatDateLondon(booking.end)}</li>
        <li><b>Customer:</b> ${booking.firstName} ${booking.lastName}</li>
        <li><b>Email:</b> ${booking.email || "—"}</li>
      </ul>
      <hr/>
      <p style="font-size:12px; color:#777; text-align:center;">
        Equine Transport UK<br/>
        Upper Broadreed Farm, Stonehurst Lane, Five Ashes, TN20 6LL, East Sussex, GB<br/>
        📞 +44 7584578654 | ✉️ <a href="mailto:info@equinetransportuk.com">info@equinetransportuk.com</a>
      </p>
    </div>`;
}

//// PART 2 OF 4 — START

//// ----------------------------------------------------
// Fetch basic booking summary from Planyo
// (API key + site_id + hash_timestamp ONLY)
// ----------------------------------------------------
async function fetchPlanyoBooking(bookingID) {
  try {
    const ts = Math.floor(Date.now() / 1000);

    const query = new URLSearchParams({
      method: "get_reservation_data",
      api_key: process.env.PLANYO_API_KEY,
      site_id: process.env.PLANYO_SITE_ID,
      reservation_id: bookingID,
      hash_timestamp: String(ts),
    });

    const url = `https://www.planyo.com/rest/?${query.toString()}`;
    console.log("🔗 Planyo booking URL:", url);

    const resp = await fetch(url);
    const text = await resp.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("Non-JSON Planyo response");
    }

    if (json?.response_code !== 0 || !json.data) {
      console.error("❌ Planyo error:", json);
      throw new Error(json.response_message || "Planyo error");
    }

    const d = json.data;

    return {
      resource: d.name || "N/A",
      start: d.start_time || "N/A",
      end: d.end_time || "N/A",
      firstName: d.first_name || "",
      lastName: d.last_name || "",
      email: d.email || null,
    };

  } catch (err) {
    console.error("⚠️ fetchPlanyoBooking failed:", err.message);
    return {
      resource: "N/A",
      start: "N/A",
      end: "N/A",
      firstName: "",
      lastName: "",
      email: null,
    };
  }
}

// ----------------------------------------------------
// Persistent duplicate-protection (Render disk at /data)
// ----------------------------------------------------
const DATA_DIR = "/data";
const SENT_FILE = path.join(DATA_DIR, "sentDeposits.json");
const CALLBACK_FILE = path.join(DATA_DIR, "processedCallbacks.json");
const FORM_STATUS_FILE = path.join(DATA_DIR, "form-status.json");

let formStatus = {};
try {
  if (fs.existsSync(FORM_STATUS_FILE)) {
    const raw = fs.readFileSync(FORM_STATUS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") formStatus = parsed;
  }
} catch (e) {
  console.warn("⚠️ Could not load form status:", e.message);
  formStatus = {};
}

function saveFormStatus() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FORM_STATUS_FILE, JSON.stringify(formStatus, null, 2));
  } catch (e) {
    console.error("❌ Could not write form status:", e.message);
  }
}

function loadSet(file) {
  try {
    if (fs.existsSync(file)) {
      const arr = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(arr)) return new Set(arr);
      if (arr && typeof arr === "object") return new Set(Object.keys(arr));
    }
  } catch (e) {
    console.warn(`⚠️ Could not read ${file}:`, e.message);
  }
  return new Set();
}

function saveSet(file, set) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...set]));
  } catch (e) {
    console.error(`❌ Could not write ${file}:`, e.message);
  }
}

let processedBookings = loadSet(CALLBACK_FILE);
let sentDepositBookings = loadSet(SENT_FILE);

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
cron.schedule("0 0 * * *", () => {
  try {
    const cutoff = Date.now() - THREE_DAYS_MS;
    const clean = new Set(
      [...sentDepositBookings].filter((entry) => {
        const [id, ts] = String(entry).split(":");
        return !isNaN(Number(ts)) && Number(ts) > cutoff;
      })
    );
    sentDepositBookings = clean;
    saveSet(SENT_FILE, clean);
  } catch (e) {
    console.warn("⚠️ Cleanup failed:", e.message);
  }
});

function markDepositSent(bookingID) {
  sentDepositBookings.add(`${bookingID}:${Date.now()}`);
  saveSet(SENT_FILE, sentDepositBookings);
}

function alreadySentRecently(bookingID) {
  const cutoff = Date.now() - THREE_DAYS_MS;
  for (const entry of sentDepositBookings) {
    const [id, ts] = String(entry).split(":");
    if (id === String(bookingID) && Number(ts) > cutoff) return true;
  }
  return false;
}

// ----------------------------------------------------
// Generic Planyo REST call (NO hash / NO timestamp)
// ----------------------------------------------------
async function planyoCall(method, params = {}) {
  try {
    const query = new URLSearchParams({
      method,
      api_key: process.env.PLANYO_API_KEY,
      site_id: process.env.PLANYO_SITE_ID,
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)])
      ),
    });

    const url = `https://www.planyo.com/rest/?${query.toString()}`;

    const resp = await fetch(url);
    const text = await resp.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.error("❌ Planyo returned non-JSON:", text.slice(0, 300));
      return {
        url,
        json: { response_code: 1, response_message: "Non-JSON response" },
      };
    }

    if (json?.response_code !== 0) {
      console.warn(
        "⚠️ Planyo error:",
        json?.response_message || json
      );
    }

    return { url, json };

  } catch (err) {
    console.error("❌ Planyo REST call failed:", err);
    return {
      url: null,
      json: { response_code: 1, response_message: err.message },
    };
  }
}

// ----------------------------------------------------
// LONG vs SHORT questionnaire decision helpers
// ----------------------------------------------------
function parsePlanyoDate(str) {
  if (!str || typeof str !== "string") return null;
  const [datePart, timePart] = str.split(" ");
  if (!datePart || !timePart) return null;
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm, ss] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, ss || 0);
}

function diffInDays(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

function formatPlanyoDateTime(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ----------------------------------------------------
// Helpers
// ----------------------------------------------------
function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}


// ----------------------------------------------------
// Decide whether SHORT or LONG questionnaire is required
// ----------------------------------------------------
async function decideFormTypeForBooking(email, currentStartStr, currentReservationId) {
  if (!email || !currentStartStr) return "long";

  const currentStart = parsePlanyoDate(currentStartStr);
  if (!currentStart || isNaN(currentStart.getTime())) return "long";

  const oneYearAgo = new Date(currentStart.getTime() - 365 * 24 * 60 * 60 * 1000);
  const start_time = formatPlanyoDateTime(oneYearAgo);
  const end_time = formatPlanyoDateTime(currentStart);

  const { json } = await planyoCall("list_reservations", {
    start_time,
    end_time,
    user_email: email,
    required_status: 4,
    sort: "start_time",
    sort_reverse: 1,
    detail_level: 1
  });

  const results = json?.data?.results || [];
  if (!results.length) return "long";

  let lastPrev = null;
  for (const r of results) {
    const rid = String(r.reservation_id || "");
    const st = parsePlanyoDate(r.start_time);
    if (!st || isNaN(st.getTime())) continue;
    if (rid === String(currentReservationId)) continue;
    if (st < currentStart && (!lastPrev || st > lastPrev.start)) {
      lastPrev = { start: st };
    }
  }
  if (!lastPrev) return "long";

  const days = diffInDays(currentStart, lastPrev.start);
  return days <= 90 ? "short" : "long";
}

// ----------------------------------------------------
// Send questionnaire email — customer + admin
// ----------------------------------------------------
async function sendQuestionnaireEmail({ bookingID, customerName, email, formType }) {
  if (!email) return;

  const isShort = formType === "short";
  const formName = isShort ? "SHORT Form" : "LONG Form";
  const baseShort = "https://www.equinetransportuk.com/shortformsubmit";
  const baseLong = "https://www.equinetransportuk.com/longformsubmit";
  const formUrl = isShort
    ? `${baseShort}?bookingID=${encodeURIComponent(bookingID)}`
    : `${baseLong}?bookingID=${encodeURIComponent(bookingID)}`;

  // fetch full booking to display details
  const bk = await fetchPlanyoBooking(bookingID);

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif; font-size:16px; color:#333; line-height:1.6; max-width:720px; margin:auto;">

    <!-- Logo -->
    <div style="text-align:center; margin-bottom:20px;">
      <img src="https://planyo-ch.s3.eu-central-2.amazonaws.com/site_logo_68785.png?v=90715"
           alt="Equine Transport UK"
           style="max-width:200px; height:auto;" />
    </div>

    <!-- Title -->
    <h2 style="text-align:center; color:#0070f3; margin-bottom:10px;">
      Millins Hire Questionnaire – ${formName} Required
    </h2>

    <p>Dear ${customerName || "hirer"},</p>

    <p>
      Based on your booking history, you are required to complete the
      <strong>${formName}</strong> before your hire.
    </p>

    <!-- Booking details box -->
    <div style="background:#f8f9ff; border:1px solid #d6e7ff; border-radius:8px; padding:14px 18px; margin:22px 0;">
      <h3 style="margin:0 0 10px; color:#124a8a;">Booking Details</h3>
      <ul style="padding-left:18px; margin:0;">
        <li><strong>Booking reference:</strong> #${bookingID}</li>
        <li><strong>Lorry:</strong> ${bk.resource || "N/A"}</li>
        <li><strong>From:</strong> ${formatDateLondon(bk.start)}</li>
        <li><strong>To:</strong> ${formatDateLondon(bk.end)}</li>
        <li><strong>Customer:</strong> ${bk.firstName || ""} ${bk.lastName || ""}</li>
        <li><strong>Email:</strong> ${bk.email || "N/A"}</li>
      </ul>
    </div>

    <!-- Button -->
    <div style="text-align:center; margin:32px 0;">
      <a href="${formUrl}"
         style="background:#0070f3; color:#fff; padding:14px 32px; border-radius:6px;
                font-size:18px; font-weight:bold; text-decoration:none; display:inline-block;">
        Complete the ${formName}
      </a>
    </div>

    <p>If the button does not work, click this link:</p>
    <p style="word-break:break-all;">
      <a href="${formUrl}" style="color:#0070f3;">${formUrl}</a>
    </p>

    <br>
    <p>With kind regards,<br><strong>Koos & Avril</strong><br>Equine Transport UK</p>

    <hr style="margin:30px 0;" />

    <p style="font-size:12px; color:#777; text-align:center;">
      Equine Transport UK<br/>
      Upper Broadreed Farm, Stonehurst Lane, Five Ashes, TN20 6LL, East Sussex, GB<br/>
      📞 +44 7584578654 | ✉️ <a href="mailto:info@equinetransportuk.com">info@equinetransportuk.com</a>
    </p>
  </div>
  `;

  const subject = `Equine Transport UK – Please complete ${formName} for booking #${bookingID}`;

  await sendgrid.send({
    to: email,
    from: "Equine Transport UK <info@equinetransportuk.com>",
    subject,
    html,
  });

  await sendgrid.send({
    to: "kverhagen@mac.com",
    from: "Equine Transport UK <info@equinetransportuk.com>",
    subject: `Admin – ${subject}`,
    html,
  });
}

// ------------------------------------------------------
// FORCE RESEND QUESTIONNAIRE (from iOS HireCheck app)
// ------------------------------------------------------
app.post("/forms/manual-resend", express.json(), async (req, res) => {
  try {
    const { bookingID, force, adminCopy } = req.body;

    if (!bookingID) {
      return res.status(400).json({ error: "Missing bookingID" });
    }

    console.log(`📨 Force resend triggered for booking #${bookingID}`);

    const bookingUrl = `${PUBLIC_API_BASE}/planyo/booking/${bookingID}`;
    const bookingData = await fetch(bookingUrl).then((r) => r.json());

    const {
      bookingID: id,
      customerName,
      email,
      startDate,
      formStatus,
    } = bookingData;

    let formType = formStatus?.requiredForm;

    if (!formType || force) {
      formType = await decideFormTypeForBooking(email, startDate, bookingID);
    }

    await sendQuestionnaireEmail({
      bookingID: id,
      customerName,
      email,
      formType,
      adminCopy: !!adminCopy,
    });

    console.log(`📬 Questionnaire resent for booking #${bookingID}`);

    return res.json({
      success: true,
      sent: true,
      bookingID,
      formType,
    });
  } catch (err) {
    console.error("❌ Force resend error:", err);
    return res.status(500).json({ error: err.message });
  }
});


// ----------------------------------------------------
// Stripe Terminal & Deposit endpoints
// ----------------------------------------------------

// connection token for Stripe Terminal app (HireCheck)
app.post("/terminal/connection_token", async (_req, res) => {
  try {
    const connectionToken = await stripe.terminal.connectionTokens.create();
    res.json({ secret: connectionToken.secret });
  } catch (err) {
    console.error("❌ /terminal/connection_token error:", err);
    res.status(500).json({ error: err.message });
  }
});

// create PaymentIntent for terminal (capture_method: manual)
app.post("/deposit/create-intent", async (req, res) => {
  try {
    const { bookingID, amount } = req.body;
    const booking = await fetchPlanyoBooking(bookingID);

    const description = [
      `Booking #${bookingID}`,
      `${booking.firstName} ${booking.lastName}`.trim(),
      booking.resource,
      `${booking.start} → ${booking.end}`,
    ]
      .filter(Boolean)
      .join(" | ");

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: "gbp",
      capture_method: "manual",
      payment_method_types: ["card"],
      metadata: { bookingID },
      description,
    });

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error("❌ /deposit/create-intent error:", err);
    res.status(500).json({ error: err.message });
  }
});

// web-based deposit page (standard card form)
app.get("/deposit/pay/:bookingID", async (req, res) => {
  const bookingID = req.params.bookingID;
  const amount = 20000;

  const bk = await fetchPlanyoBooking(bookingID);

  const intent = await stripe.paymentIntents.create({
    amount,
    currency: "gbp",
    capture_method: "manual",
    payment_method_types: ["card"],
    metadata: { bookingID },
    description: `Booking #${bookingID} | ${bk.firstName} ${bk.lastName} | ${bk.resource}`,
  });

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<title>Deposit Hold - Booking ${bookingID}</title>
<script src="https://js.stripe.com/v3/"></script>
<style>
body{margin:0;padding:0;background:#f6f7fb;font-family:Helvetica,Arial,sans-serif}
.container{max-width:600px;margin:20px auto;background:#fff;padding:16px;border-radius:10px;box-sizing:border-box}
.logo{text-align:center;margin-bottom:16px}
.logo img{width:140px;height:auto}
h2{text-align:center;margin:0 0 10px;color:#0070f3;font-size:1.3rem}
p.center{text-align:center;margin:6px 0;color:#555;word-wrap:break-word}
label{display:block;margin-top:10px;font-weight:600;font-size:.9rem}
.StripeElement,input{width:100%;box-sizing:border-box;padding:10px;border:1.5px solid #d8dce6;border-radius:8px;background:#fff;margin-top:4px;font-size:15px}
button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:10px;background:#0070f3;color:#fff;font-size:16px;cursor:pointer}
#result{margin-top:12px;text-align:center;font-size:.95rem}
.footer{font-size:12.5px;color:#777;text-align:center;line-height:1.5}
.footer a{color:#0070f3;text-decoration:none;font-weight:500}
@media (max-width:480px){.container{margin:10px;padding:12px;border-radius:8px}.StripeElement,input{padding:8px;font-size:14px}button{padding:10px;font-size:15px}h2{font-size:1.1rem}}
</style></head><body>
<div class="container">
  <div class="logo">
    <img src="https://planyo-ch.s3.eu-central-2.amazonaws.com/site_logo_68785.png?v=90715" alt="Equine Transport UK Logo"/>
  </div>
  <h2>Deposit Hold (£${(amount / 100).toFixed(2)})</h2>
  <p class="center">
    Booking <b>#${bookingID}</b><br/>${bk.firstName} ${bk.lastName}<br/>${bk.resource}<br/>${bk.start} → ${bk.end}
  </p>
  <form id="payment-form">
    <label>Full Name</label><input id="full-name" placeholder="Full Name" required />
    <label>Card Number</label><div id="card-number" class="StripeElement"></div>
    <label>Expiry</label><div id="card-expiry" class="StripeElement"></div>
    <label>CVC</label><div id="card-cvc" class="StripeElement"></div>
    <label>Postcode</label><input id="postal-code" placeholder="Postcode" required />
    <button id="submit">Confirm Hold</button><div id="result"></div>
  </form>
  <hr/>
  <p class="footer"><strong>Equine Transport UK</strong><br/>Upper Broadreed Farm, Stonehurst Lane, Five Ashes,<br/>TN20 6LL, East Sussex, GB<br/>📞 +44 7812 188871 | ✉️ <a href="mailto:info@equinetransportuk.com">info@equinetransportuk.com</a></p>
</div>
<script>
const stripe = Stripe("${process.env.STRIPE_PUBLISHABLE_KEY}");
const clientSecret = "${intent.client_secret}";
const elements = stripe.elements({ style: { base: { fontSize: "15px", fontFamily:"Helvetica, Arial, sans-serif" } } });
const cardNumber = elements.create("cardNumber");cardNumber.mount("#card-number");
const cardExpiry = elements.create("cardExpiry");cardExpiry.mount("#card-expiry");
const cardCvc = elements.create("cardCvc");cardCvc.mount("#card-cvc");
document.getElementById("payment-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultDiv = document.getElementById("result");
  resultDiv.textContent = "⏳ Processing…";
  const fullName = document.getElementById("full-name").value.trim();
  const postalCode = document.getElementById("postal-code").value.trim();
  if (!fullName) { resultDiv.textContent = "⚠️ Please enter your full name."; return; }
  const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
    payment_method: { card: cardNumber, billing_details: { name: fullName, address: { postal_code: postalCode } } }
  });
  if (error) { resultDiv.textContent = "❌ " + error.message; }
  else if (paymentIntent && paymentIntent.status === "requires_capture") {
    resultDiv.textContent = "✅ Hold Successful. Redirecting…";
    fetch("${PUBLIC_API_BASE}/update-metadata",{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({payment_intent_id: paymentIntent.id, metadata: { fullName }})}).catch(()=>{});
    fetch("${PUBLIC_API_BASE}/email/deposit-confirmation",{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({ bookingID:"${bookingID}", amount:${amount} })}).catch(()=>{});
    setTimeout(()=>{ window.location.href = "https://www.equinetransportuk.com/thank-you?bookingID=${bookingID}&amount=${amount}"; }, 2000);
  } else { resultDiv.textContent = "ℹ️ Status: " + paymentIntent.status; }
});
</script>
</body></html>`);
});

// update PaymentIntent metadata
app.post("/update-metadata", async (req, res) => {
  try {
    const { payment_intent_id, metadata } = req.body;
    await stripe.paymentIntents.update(payment_intent_id, { metadata });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Metadata update failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// list all open holds (requires_capture) for internal admin
app.get("/terminal/list-all", async (_req, res) => {
  try {
    const paymentIntents = await stripe.paymentIntents.list({ limit: 50 });
    const deposits = [];
    for (const pi of paymentIntents.data) {
      if (pi.metadata?.bookingID && pi.status === "requires_capture") {
        const bk = await fetchPlanyoBooking(pi.metadata.bookingID);
        deposits.push({
          id: pi.id,
          bookingID: pi.metadata.bookingID,
          amount: pi.amount,
          status: "Hold Successful",
          created: pi.created,
          name: bk.resource,
          start: bk.start,
          end: bk.end,
          customer: `${bk.firstName} ${bk.lastName}`.trim(),
        });
      }
    }
    res.json(deposits);
  } catch (err) {
    console.error("❌ /terminal/list-all error:", err);
    res.status(500).json({ error: err.message });
  }
});

// cancel hold (PaymentIntent cancel)
app.post("/terminal/cancel", async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    const canceled = await stripe.paymentIntents.cancel(payment_intent_id);
    const bookingID = canceled.metadata?.bookingID;
    console.log(
      `⚠️ Deposit canceled: ${payment_intent_id} (Booking #${
        bookingID || "unknown"
      })`
    );

    if (bookingID) {
      const bk = await fetchPlanyoBooking(bookingID);
      if (bk.email) {
        const htmlBody = emailTemplate({
          title: "Deposit Hold Canceled",
          color: "#d9534f",
          bodyTop: `The deposit hold for <b>Booking #${bookingID}</b> has been <b>canceled</b>.`,
          bookingID,
          booking: bk,
        });
        await Promise.all([
          sendgrid.send({
            to: bk.email,
            from: "Equine Transport UK <info@equinetransportuk.com>",
            subject: `Equine Transport UK | Deposit Hold Canceled | Booking #${bookingID}`,
            html: htmlBody,
          }),
          sendgrid.send({
            to: "kverhagen@mac.com",
            from: "Equine Transport UK <info@equinetransportuk.com>",
            subject: `Admin Copy | Deposit Hold Canceled | Booking #${bookingID}`,
            html: htmlBody,
          }),
        ]);
        console.log(
          `📩 Cancel emails sent for booking #${bookingID} → ${bk.email} & admin`
        );
      }
    }
    res.json({ id: canceled.id, status: canceled.status });
  } catch (err) {
    console.error("❌ Cancel error:", err);
    res.status(500).json({ error: err.message });
  }
});

// capture hold (PaymentIntent capture)
app.post("/terminal/capture", async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    const captured = await stripe.paymentIntents.capture(payment_intent_id);
    res.json(captured);
  } catch (err) {
    console.error("❌ Capture error:", err);
    res.status(500).json({ error: err.message });
  }
});

// list all PaymentIntents for a specific bookingID
app.get("/terminal/list/:bookingID", async (req, res) => {
  try {
    const bookingID = String(req.params.bookingID);
    const paymentIntents = await stripe.paymentIntents.list({ limit: 100 });

    const deposits = paymentIntents.data.filter(
      (pi) => pi.metadata && String(pi.metadata.bookingID) === bookingID
    );

    const bk = await fetchPlanyoBooking(bookingID);

    const result = deposits.map((pi) => ({
      id: pi.id,
      bookingID,
      amount: pi.amount,
      status: pi.status === "requires_capture" ? "Hold Successful" : pi.status,
      created: pi.created,
      name: bk.resource,
      start: bk.start,
      end: bk.end,
      customer: `${bk.firstName} ${bk.lastName}`.trim(),
    }));

    res.json(result);
  } catch (err) {
    console.error("❌ /terminal/list error:", err);
    res.status(500).json({ error: err.message });
  }
});

// public: check deposit status from Wix thank-you / other frontends
app.get("/deposit/status/:bookingID", async (req, res) => {
  try {
    const bookingID = String(req.params.bookingID);
    console.log(`🔎 Checking deposit status for booking #${bookingID}`);

    const paymentIntents = await stripe.paymentIntents.list({ limit: 100 });
    const matching = paymentIntents.data.filter(
      (pi) => pi.metadata && String(pi.metadata.bookingID) === bookingID
    );

    const successIntent = matching.find(
      (pi) => pi.status === "succeeded" || pi.status === "requires_capture"
    );

    if (successIntent) {
      console.log(
        `✅ Deposit found for #${bookingID}: ${successIntent.status} (${successIntent.amount / 100} GBP)`
      );
      return res.json({
        success: true,
        amount: (successIntent.amount / 100).toFixed(2),
        status: successIntent.status,
        created: successIntent.created,
      });
    }

    console.log(`⚠️ No active deposit found for booking #${bookingID}`);
    res.json({ success: false });
  } catch (err) {
    console.error("❌ Deposit status check failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// Form status for HireCheck (LONG/SHORT + DVLA fields)
// ----------------------------------------------------
app.get("/forms/status/:bookingID", (req, res) => {
  const bookingID = String(req.params.bookingID);

  const saved = formStatus[bookingID] || {};

  const response = {
    requiredForm: saved.requiredForm ?? null,
    shortDone: saved.shortDone ?? false,
    longDone: saved.longDone ?? false,

    // DVLA fields returned safely
    dvlaLast8: saved.dvlaLast8 ?? null,
    dvlaCode: saved.dvlaCode ?? null,
    dvlaStatus: saved.dvlaStatus ?? "pending"
  };

  return res.json(response);
});

// ----------------------------------------------------
// Deposit confirmation email sent after successful hold
// ----------------------------------------------------
app.post("/email/deposit-confirmation", async (req, res) => {
  try {
    const { bookingID, amount } = req.body;
    const bk = await fetchPlanyoBooking(bookingID);
    if (!bk.email) {
      return res
        .status(400)
        .json({ error: "Could not find customer email" });
    }

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333;">
        <img src="https://static.wixstatic.com/media/a9ff84_dfc6008558f94e88a3be92ae9c70201b~mv2.webp"
             alt="Equine Transport UK"
             style="width:160px; height:auto; display:block; margin:0 auto 20px auto;" />
        <h2 style="text-align:center; color:#0070f3;">Deposit Hold Confirmation</h2>
        <p><b>Note:</b> This is a <b>pre-authorisation (hold)</b>. <b>No money has been taken</b> from your account.</p>
        <p>Dear ${bk.firstName} ${bk.lastName},</p>
        <p>We have successfully placed a deposit hold of <b>£${(
          amount / 100
        ).toFixed(2)}</b> for your booking <b>#${bookingID}</b>.</p>
        <h3>Booking Details</h3>
        <ul>
          <li><b>Lorry:</b> ${bk.resource}</li>
          <li><b>From:</b> ${formatDateLondon(bk.start)}</li>
          <li><b>To:</b> ${formatDateLondon(bk.end)}</li>
          <li><b>Customer:</b> ${bk.firstName} ${bk.lastName}</li>
          <li><b>Email:</b> ${bk.email}</li>
        </ul>
        <h3>About This Deposit</h3>
        <p>The funds remain reserved on your card until we either:</p>
        <ul>
          <li>Release the hold (normally within 7 days of vehicle return), or</li>
          <li>Capture part or all of the deposit if required by the hire agreement.</li>
        </ul>
        <p>The deposit covers costs such as refuelling if not returned full, damage/excessive wear, or other costs per your agreement.</p>
        <p style="margin-top:30px;">With kind regards,<br/>Koos & Avril<br/><b>Equine Transport UK</b></p>
        <hr style="margin:30px 0;" />
        <p style="font-size:12px; color:#777; text-align:center;">
          Equine Transport UK<br/>
          Upper Broadreed Farm, Stonehurst Lane, Five Ashes, TN20 6LL, East Sussex, GB<br/>
          📞 +44 7584578654 | ✉️ <a href="mailto:info@equinetransportuk.com">info@equinetransportuk.com</a>
        </p>
      </div>`;

    await Promise.all([
      sendgrid.send({
        to: bk.email,
        from: "Equine Transport UK <info@equinetransportuk.com>",
        subject: `Equine Transport UK | Deposit Hold Confirmation #${bookingID} | ${bk.firstName} ${bk.lastName}`,
        html: htmlBody,
      }),
      sendgrid.send({
        to: "kverhagen@mac.com",
        from: "Equine Transport UK <info@equinetransportuk.com>",
        subject: `Admin Copy | Deposit Hold Confirmation #${bookingID} | ${bk.firstName} ${bk.lastName}`,
        html: htmlBody,
      }),
    ]);

    res.json({ success: true, email: bk.email });
  } catch (err) {
    console.error("❌ SendGrid confirmation error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// Deposit link sender (V2 with manual override)
// ----------------------------------------------------
app.post("/deposit/send-link", async (req, res) => {
  try {
    const { bookingID, amount = 20000, force } = req.body;
    const link = `https://www.equinetransportuk.com/deposit?bookingID=${bookingID}`;

    const isForced =
      force === true || force === "true" || force === 1 || force === "1";

    if (!isForced && alreadySentRecently(bookingID)) {
      console.log(`⏩ Skipping duplicate deposit send for #${bookingID} (recent)`);
      return res.json({ success: true, url: link, alreadySent: true });
    }

    const bk = await fetchPlanyoBooking(bookingID);
    if (!bk.email) {
      console.warn(`⚠️ No customer email for booking #${bookingID}`);
      return res.json({ success: false, error: "No customer email" });
    }

    const amountText = (amount / 100).toFixed(2);

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif; line-height:1.6; color:#333; max-width:720px; margin:0 auto; padding:20px;">
        <!-- Logo -->
        <div style="text-align:center; margin-bottom:20px;">
          <img src="https://planyo-ch.s3.eu-central-2.amazonaws.com/site_logo_68785.png?v=90715"
               alt="Equine Transport UK"
               style="max-width:200px; height:auto;" />
        </div>

        <!-- Title -->
        <h2 style="text-align:center; color:#0070f3; margin-bottom:10px;">
          Equine Transport UK – Deposit Payment Request${isForced ? " (Resent)" : ""}
        </h2>

        <p>Dear ${bk.firstName || ""} ${bk.lastName || ""},</p>

        <p>
          Thank you for your booking with <strong>Equine Transport UK</strong>.<br/>
          Please complete your <strong>deposit hold</strong> for the hire below.
        </p>

        <!-- Booking details -->
        <div style="background:#f8f9ff; border:1px solid #d6e7ff; border-radius:8px; padding:12px 16px; margin:18px 0;">
          <h3 style="margin-top:0; margin-bottom:8px; color:#124a8a;">Booking Details</h3>
          <ul style="padding-left:18px; margin:0;">
            <li><strong>Booking reference:</strong> #${bookingID}</li>
            <li><strong>Lorry:</strong> ${bk.resource || "N/A"}</li>
            <li><strong>From:</strong> ${bk.start ? formatDateLondon(bk.start) : "N/A"}</li>
            <li><strong>To:</strong> ${bk.end ? formatDateLondon(bk.end) : "N/A"}</li>
            <li><strong>Customer:</strong> ${bk.firstName || ""} ${bk.lastName || ""}</li>
            <li><strong>Email:</strong> ${bk.email || "N/A"}</li>
          </ul>
        </div>

        <!-- Amount + button -->
        <p style="font-size:16px; margin:14px 0;">
          The required deposit hold amount is:
          <strong style="font-size:18px;">£${amountText}</strong>
        </p>

        <div style="text-align:center; margin:26px 0;">
          <a href="${link}"
             style="display:inline-block; padding:14px 28px; background:#0070f3; color:#ffffff;
                    border-radius:6px; text-decoration:none; font-size:16px; font-weight:bold;">
            💳 Pay Deposit Securely
          </a>
        </div>

        <p>If the button does not work, please use this link:</p>
        <p style="word-break:break-all;">
          <a href="${link}" style="color:#0070f3; text-decoration:none;">${link}</a>
        </p>

        <!-- Pre-authorisation note -->
        <div style="background:#fff8e5; border:1px solid #f2c96a; border-radius:8px; padding:12px 16px; margin-top:24px; font-size:14px; color:#6b4b00;">
          <strong>Important:</strong> This is a <strong>pre-authorisation (hold)</strong>, not an immediate payment.
          The funds are reserved on your card and will either be released after the hire
          or partially/fully captured only if required under the hire agreement
          (for example, damage, excessive cleaning, or fuel charges).
        </div>

        <p style="margin-top:28px;">
          With kind regards,<br/>
          <strong>Koos &amp; Avril</strong><br/>
          <strong>Equine Transport UK</strong>
        </p>

        <hr style="margin:30px 0 16px; border:none; border-top:1px solid #ddd;" />

        <!-- Footer -->
        <div style="font-size:12px; color:#777; text-align:center; line-height:1.5;">
          <p style="margin:4px 0;">
            Equine Transport UK<br/>
            Upper Broadreed Farm, Stonehurst Lane, Five Ashes, TN20 6LL, East Sussex, GB
          </p>
          <p style="margin:4px 0;">
            📞 +44 7584 578654<br/>
            ✉️ <a href="mailto:info@equinetransportuk.com" style="color:#777; text-decoration:none;">info@equinetransportuk.com</a><br/>
            🌍 <a href="https://www.equinetransportuk.com" style="color:#777; text-decoration:none;">www.equinetransportuk.com</a>
          </p>
        </div>
      </div>
    `;

    const subjectBase = `Equine Transport UK | Secure Deposit Link${isForced ? " (Resent)" : ""}`;
    const subjectDetail = `Booking #${bookingID} | ${bk.firstName || ""} ${bk.lastName || ""}`.trim();

    await Promise.all([
      sendgrid.send({
        to: bk.email,
        from: "Equine Transport UK <info@equinetransportuk.com>",
        subject: `${subjectBase} | ${subjectDetail}`,
        html,
      }),
      sendgrid.send({
        to: "kverhagen@mac.com",
        from: "Equine Transport UK <info@equinetransportuk.com>",
        subject: `Admin Copy | ${subjectBase} | ${subjectDetail}`,
        html,
      }),
    ]);

    if (!isForced) {
      markDepositSent(bookingID);
    }

    console.log(
      `✅ Deposit link ${isForced ? "resent" : "sent"} for booking #${bookingID} to ${bk.email}`
    );

    return res.json({
      success: true,
      url: link,
      forced: isForced,
      email: bk.email,
    });
  } catch (err) {
    console.error("❌ SendGrid deposit-link error:", err);
    return res.json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// HIRECHECK ENDPOINT — always triggers manual resend
// ----------------------------------------------------
app.post("/deposit/resend", (req, res) => {
  const { bookingID, amount = 20000 } = req.body;
  return fetch(`${PUBLIC_API_BASE}/deposit/send-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookingID, amount, force: true }),
  })
    .then((r) => r.json())
    .then((data) => res.json(data))
    .catch((err) => res.json({ success: false, error: err.message }));
});

// ----------------------------------------------------
// Wix → mark Short/Long form submitted
// ----------------------------------------------------
app.post("/forms/submit", express.json(), (req, res) => {
  const { email, type, bookingID } = req.body || {};
  if (!email || !type) {
    return res.status(400).json({ error: "Missing email or form type" });
  }

  const formType = type.toLowerCase() === "short" ? "short" : "long";

  if (bookingID) {
    console.log(`📨 Form submit: booking ${bookingID} → ${formType} = DONE`);
    if (!formStatus[bookingID]) {
      formStatus[bookingID] = {
        requiredForm: formType,
        shortDone: false,
        longDone: false,
      };
    }
    if (formType === "short") formStatus[bookingID].shortDone = true;
    if (formType === "long") formStatus[bookingID].longDone = true;
    saveFormStatus();
    return res.json({ ok: true });
  }

  const keys = Object.keys(formStatus);
  let target = keys.find(
    (bid) => formStatus[bid] && formStatus[bid].email === email
  );

  if (!target) {
    console.warn(`⚠️ Form submit: cannot match email ${email} to booking`);
    return res.status(200).json({ ok: false, warning: "No booking matched" });
  }

  console.log(`📨 Form submit: inferred booking ${target} → ${formType} = DONE`);
  if (formType === "short") formStatus[target].shortDone = true;
  if (formType === "long") formStatus[target].longDone = true;
  saveFormStatus();
  res.json({ ok: true });
});

//// ----------------------------------------------------
// Customer finished questionnaire (SHORT or LONG) + DVLA fields
// ----------------------------------------------------
app.post("/forms/submitted", express.json(), async (req, res) => {
  try {
    const bookingID = String(req.body.bookingID || "").trim();
    const formType = String(req.body.formType || "").toLowerCase();
    const licenceNumber = req.body.licenceNumber?.trim() || null;
    const dvlaCode = req.body.dvlaCode?.trim() || null;
    

    if (!bookingID || !formType) {
      return res.status(400).json({ error: "Missing bookingID or formType" });
    }

    if (!["short", "long"].includes(formType)) {
      return res.status(400).json({ error: "formType must be 'short' or 'long'" });
    }

    // 🔹 Initialize if not exist
    const status = formStatus[bookingID] || {
      requiredForm: formType,
      shortDone: false,
      longDone: false,
      dvlaStatus: "pending"
    };

    // 🔹 Record completion
    if (formType === "short") status.shortDone = true;
    if (formType === "long") status.longDone = true;

    // --- DVLA STORE + DETECT CHANGE ---
    let dvlaChanged = false;

    if (licenceNumber && licenceNumber !== status.licenceNumber) {
      status.licenceNumber = licenceNumber;
      status.dvlaLast8 = licenceNumber.slice(-8);
      dvlaChanged = true;
    }

    if (dvlaCode && dvlaCode !== status.dvlaCode) {
      status.dvlaCode = dvlaCode;
      dvlaChanged = true;
    }

    // Reset DVLA result if number or code changed
    if (dvlaChanged) {
      status.dvlaStatus = "pending";
      status.dvlaNameMatch = null;    
    }

    // Final save
    status.updatedAt = new Date().toISOString();
    formStatus[bookingID] = status;
    saveFormStatus();

    console.log(`🟢 Form submitted #${bookingID} (${formType.toUpperCase()})`);
    console.log(
  `     DVLA: last8=${status.dvlaLast8 || "—"} | code=${status.dvlaCode || "—"} | status=${status.dvlaStatus || "—"}`
);

    return res.json({ success: true, bookingID, status });

  } catch (err) {
    console.error("❌ Error in /forms/submitted:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// DVLA check (HireCheck app triggers this — manual only)
// ----------------------------------------------------
app.post("/dvla/check", express.json(), async (req, res) => {
  try {
    const { bookingID } = req.body;
    const status = formStatus[bookingID];

    if (!status || !status.licenceNumber || !status.dvlaCode) {
      return res.status(400).json({ error: "Missing DVLA data for this booking" });
    }

    // Extract last 8 (legal requirement)
    const last8 = status.licenceNumber.slice(-8);

    status.dvlaStatus = "checked";   // NOT approved yet
    status.dvlaLast8 = last8;
    status.updatedAt = new Date().toISOString();

    formStatus[bookingID] = status;
    saveFormStatus();

    console.log(`🟦 DVLA CHECK STORED #${bookingID} → last8=${last8}, code=${status.dvlaCode}`);

    return res.json({
      success: true,
      bookingID,
      dvla: {
        status: status.dvlaStatus,
        last8,
        code: status.dvlaCode,
        url: "https://www.gov.uk/view-driving-licence"
      }
    });

  } catch (err) {
    console.error("❌ DVLA check error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// DVLA manual approve (no reject)
// ----------------------------------------------------
app.post("/dvla/manual-verify", express.json(), async (req, res) => {
  try {
    const bookingID = String(req.body.bookingID || "").trim();
   

    if (!bookingID) {
      return res.status(400).json({ error: "Missing bookingID" });
    }

    const existing = formStatus[bookingID] || {};

    // Mark as fully approved
    existing.dvlaStatus = "valid";    
    existing.updatedAt = new Date().toISOString();

    formStatus[bookingID] = existing;
    saveFormStatus();

   

    return res.json({
      success: true,
      bookingID,
      dvlaStatus: existing.dvlaStatus,
    });
  } catch (err) {
    console.error("❌ /dvla/manual-verify error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// Manual scheduler trigger
// ----------------------------------------------------
app.get("/trigger-daily-deposits", async (_req, res) => {
  try {
    console.log("⚡ Manual deposit scheduler triggered");
    await runDepositScheduler("manual");
    res.send("✅ Daily deposits triggered");
  } catch (err) {
    console.error("❌ Manual trigger failed:", err);
    res.status(500).send("Error running deposit scheduler");
  }
});

// ----------------------------------------------------
// Booking payments (for Wix thank-you embed)
// ----------------------------------------------------
app.get("/bookingpayments/list/:bookingID", async (req, res) => {
  try {
    const { bookingID } = req.params;

    // ✅ Modern Planyo REST — API key only
    const query = new URLSearchParams({
      method: "get_reservation_data",
      api_key: process.env.PLANYO_API_KEY,
      site_id: process.env.PLANYO_SITE_ID,
      reservation_id: bookingID,
      details: "1",
    });

    const url = `https://www.planyo.com/rest/?${query.toString()}`;
    console.log("🔗 Planyo payments URL:", url);

    const resp = await fetch(url);
    const text = await resp.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.error("❌ Non-JSON Planyo response:", text.slice(0, 300));
      return res.status(500).json({ error: "Invalid Planyo response" });
    }

    if (json?.response_code !== 0 || !json.data) {
      console.error("❌ Planyo error:", json);
      return res.status(500).json({
        error: "Planyo error",
        raw: json,
      });
    }

    const r = json.data;

    const total = parseFloat(r.total_price || 0);
    const paid = parseFloat(r.amount_paid || 0);
    const balance = Math.max(total - paid, 0);

    return res.json({
      bookingID,
      customer: `${r.first_name || ""} ${r.last_name || ""}`.trim(),
      resource: r.name || "—",
      start: r.start_time || "",
      end: r.end_time || "",
      total: total.toFixed(2),
      paid: paid.toFixed(2),
      balance: balance.toFixed(2),
    });
  } catch (err) {
    console.error("❌ Booking payment fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});


// proxy HTML wrapper so Wix can embed thank-you page nicely
app.get("/booking-thankyou-proxy", (req, res) => {
  const query = req.url.split("?")[1] || "";
  const url = `${PUBLIC_API_BASE}/thankyou-embed.html?${query}`;
  res.send(`<!DOCTYPE html><html lang="en"><head>
  <meta http-equiv="refresh" content="0; url=${url}">
  <script>window.location.replace("${url}");</script>
  </head><body>Redirecting…</body></html>`);
});

// ==================================================================
// DVLA — STORE licence + code (from Wix booking form)
// ==================================================================
app.post("/forms/dvla/save", express.json(), (req, res) => {
  const { bookingID, licenceNumber, dvlaCode } = req.body;

  if (!bookingID) return res.status(400).json({ success: false, message: "Missing bookingID" });

  const status = formStatus[bookingID] || {
    requiredForm: "long",
    shortDone: false,
    longDone: false,
  };

  // Detect change and reset DVLA status
  if (licenceNumber && status.licenceNumber !== licenceNumber) {
    status.licenceNumber = licenceNumber;
    status.dvlaStatus = "pending";
    status.dvlaLast8 = licenceNumber.slice(-8);
  }

  if (dvlaCode && status.dvlaCode !== dvlaCode) {
    status.dvlaCode = dvlaCode;
    status.dvlaStatus = "pending";
  }

  status.updatedAt = new Date().toISOString();
  formStatus[bookingID] = status;
  saveFormStatus();

  return res.json({ success: true, updated: status });
});


// ==================================================================
// DVLA — MARK CHECKED (no external API)
// ==================================================================
app.post("/forms/dvla/checked", express.json(), (req, res) => {
  const { bookingID } = req.body;
  if (!bookingID) return res.status(400).json({ success: false, message: "Missing bookingID" });

  const status = formStatus[bookingID];
  if (!status) return res.status(404).json({ success: false, message: "Booking not found" });

  const last8 = status.licenceNumber ? status.licenceNumber.slice(-8) : "";

  status.dvlaStatus = "checked";
  status.dvlaLast8 = last8;
  status.updatedAt = new Date().toISOString();

  formStatus[bookingID] = status;
  saveFormStatus();

  return res.json({ success: true, updated: status });
});


// ==================================================================
// DVLA — MANUAL APPROVE (VALID)
// ==================================================================
app.post("/forms/dvla/override-valid", express.json(), (req, res) => {
  const { bookingID, expiry } = req.body;
  if (!bookingID) return res.status(400).json({ success: false, message: "Missing bookingID" });

  const status = formStatus[bookingID];
  if (!status) return res.status(404).json({ success: false, message: "Booking not found" });

  status.dvlaStatus = "valid";
  status.updatedAt = new Date().toISOString();

  formStatus[bookingID] = status;
  saveFormStatus();

  return res.json({ success: true, updated: status });
});


// ==================================================================
// DVLA — MANUAL REJECT (INVALID)
// ==================================================================
app.post("/forms/dvla/override-invalid", express.json(), (req, res) => {
  const { bookingID } = req.body;
  if (!bookingID) return res.status(400).json({ success: false, message: "Missing bookingID" });

  const status = formStatus[bookingID];
  if (!status) return res.status(404).json({ success: false, message: "Booking not found" });

  status.dvlaStatus = "invalid";
  status.updatedAt = new Date().toISOString();

  formStatus[bookingID] = status;
  saveFormStatus();

  return res.json({ success: true, updated: status });
});


// ----------------------------------------------------
// Damage report email (PDF from HireCheck app)
// ----------------------------------------------------
app.post("/damage/send-report", async (req, res) => {
  try {
    const { bookingID, customerEmail, pdfBase64 } = req.body;
    if (!bookingID || !customerEmail || !pdfBase64) {
      return res
        .status(400)
        .json({ error: "Missing bookingID, email, or PDF data" });
    }

    await sendgrid.send({
      to: [customerEmail, "info@equinetransportuk.com"],
      from: {
        email: "info@equinetransportuk.com",
        name: "Equine Transport UK",
      },
      subject: `Damage / Fuel Report – Booking #${bookingID}`,
      html: `
        <div style="font-family:Helvetica,Arial,sans-serif;color:#333;background:#f9f9f9;padding:30px;">
          <div style="text-align:center;margin-bottom:25px;">
            <img src="https://planyo-ch.s3.eu-central-2.amazonaws.com/site_logo_68785.png?v=90715" alt="Equine Transport UK" width="220" />
          </div>
          <h2 style="color:#2b2b2b;">Pick-Up Damage & Fuel Report</h2>
          <p>Dear Customer,</p>
          <p>Please find attached your Pick-Up Damage & Fuel Report for booking <b>#${bookingID}</b>.</p>
          <p>Kind regards,<br><strong>Equine Transport UK</strong></p>
          <hr style="margin:30px 0;border:none;border-top:1px solid #ddd;" />
          <p style="font-size:12px;color:#666;text-align:center;">
            Equine Transport UK · The Millens · East Sussex ·
            <a href="mailto:info@equinetransportuk.com" style="color:#666;">info@equinetransportuk.com</a>
          </p>
        </div>`,
      attachments: [
        {
          content: pdfBase64,
          filename: `DamageReport_${bookingID}.pdf`,
          type: "application/pdf",
          disposition: "attachment",
        },
      ],
    });
    console.log(`✅ Damage report emailed for booking ${bookingID}`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ SendGrid damage report error:", err.response?.body || err);
    res.status(500).json({ error: "Email failed to send" });
  }
});

// ----------------------------------------------------
// Planyo list for HireCheck (API-key-only, no hash)
// ----------------------------------------------------
app.get("/planyo/upcoming", async (_req, res) => {
  try {
    console.log("📡 /planyo/upcoming");

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const fmt = (d) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

    const start_time = fmt(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const end_time = fmt(new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000));

    const query = new URLSearchParams({
      method: "list_reservations",
      api_key: process.env.PLANYO_API_KEY,
      site_id: process.env.PLANYO_SITE_ID,
      start_time,
      end_time,
      detail_level: "1"
    });

    const url = `https://www.planyo.com/rest/?${query.toString()}`;
    console.log("🔗", url);

    const resp = await fetch(url);
    const json = await resp.json();

    if (json?.response_code !== 0 || !json?.data?.results) {
      console.warn("⚠️ Planyo error:", json);
      return res.json([]);
    }

    console.log(`✅ Planyo returned ${json.data.results.length} bookings`);

    const bookings = json.data.results.map((b) => {
      const id = String(b.reservation_id);
      const q = formStatus[id] || {};

      return {
        bookingID: id,
        vehicleName: b.name || "—",
        startDate: b.start_time || "",
        endDate: b.end_time || "",
        customerName: `${b.first_name || ""} ${b.last_name || ""}`.trim(),
        email: b.email || "",
        phoneNumber: b.mobile_number || "",
        totalPrice: b.total_price || "",
        amountPaid: b.amount_paid || "",
        addressLine1: b.address || "",
        addressLine2: b.city || "",
        postcode: b.zip || "",
        dateOfBirth: "",
        userNotes: b.user_notes || "",
        additionalProducts: [],

        licenceNumber: q.licenceNumber || "",
        dvlaCode: q.dvlaCode || "",
        dvlaLast8: q.dvlaLast8 || "",
        dvlaStatus: q.dvlaStatus || "pending",

        requiredForm: q.requiredForm ?? null,
        shortDone: q.shortDone ?? false,
        longDone: q.longDone ?? false
      };
    });

    res.json(bookings);

  } catch (err) {
    console.error("❌ /planyo/upcoming failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// Planyo single booking (full details for QR scan / HireCheck)
// ----------------------------------------------------
app.get("/planyo/booking/:bookingID", async (req, res) => {
  try {
    const bookingID = String(req.params.bookingID);

    // ✅ REST API — NO hash / NO timestamp
    const query = new URLSearchParams({
      method: "get_reservation_data",
      api_key: process.env.PLANYO_API_KEY,
      site_id: process.env.PLANYO_SITE_ID,
      reservation_id: bookingID,
      include_form_items: "1",
      include_additional_products: "1",
    });

    const url = `https://www.planyo.com/rest/?${query.toString()}`;
    console.log("🔗 Planyo booking URL:", url);

    const resp = await fetch(url);
    const text = await resp.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.error("❌ Non-JSON Planyo response:", text.slice(0, 300));
      return res.status(500).json({ error: "Invalid Planyo response" });
    }

    if (!json?.data) {
      return res.status(404).json({
        error: "No booking found",
        raw: json,
      });
    }

    const b = json.data;

    // ----------------------------------------------------
    // Map additional products
    // ----------------------------------------------------
    const mapProducts = (arr = []) =>
      arr.map((p) => ({
        id: String(p.id || ""),
        name: p.name || "",
        quantity: Number(p.quantity || 1),
      }));

    // ----------------------------------------------------
    // Load DVLA + Form Status (local JSON)
    // ----------------------------------------------------
    const questionnaire = formStatus[bookingID] || {
      requiredForm: null,
      shortDone: false,
      longDone: false,
      licenceNumber: null,
      dvlaCode: null,
      dvlaStatus: "pending",
      dvlaNameMatch: null,
      dvlaExpiry: null,
    };

    const licenceNumber = questionnaire.licenceNumber || "";
    const dvlaCode = questionnaire.dvlaCode || "";
    const dvlaLast8 = licenceNumber ? licenceNumber.slice(-8) : "";

    // ----------------------------------------------------
    // Final response to HireCheck app
    // ----------------------------------------------------
    const booking = {
      bookingID,
      vehicleName: b.name || "—",
      startDate: b.start_time || "",
      endDate: b.end_time || "",
      customerName: `${b.first_name || ""} ${b.last_name || ""}`.trim(),
      email: b.email || "",
      phoneNumber: b.mobile_number || b.phone || "",
      totalPrice: b.total_price || "",
      amountPaid: b.amount_paid || "",
      addressLine1: b.address || "",
      addressLine2: b.city || "",
      postcode: b.zip || "",
      dateOfBirth: b.properties?.Date_of_Birth || "",
      userNotes: b.user_notes || "",
      additionalProducts: mapProducts(
        b.regular_products || b.group_products || []
      ),

      // Full form status (for DamageFormScreen / PDF)
      formStatus: {
        requiredForm: questionnaire.requiredForm,
        shortDone: questionnaire.shortDone,
        longDone: questionnaire.longDone,
        licenceNumber: questionnaire.licenceNumber,
        dvlaCode: questionnaire.dvlaCode,
        dvlaStatus: questionnaire.dvlaStatus,
        dvlaNameMatch: questionnaire.dvlaNameMatch,
        dvlaExpiry: questionnaire.dvlaExpiry,
        dvlaLast8,
      },

      // Flattened DVLA (for lists)
      licenceNumber,
      dvlaCode,
      dvlaLast8,
      dvlaStatus: questionnaire.dvlaStatus ?? "pending",
    };

    res.json(booking);
  } catch (err) {
    console.error("❌ Get booking details failed:", err);
    res.status(500).json({ error: err.message });
  }
});
// ----------------------------------------------------
// Planyo Webhook (reservation_confirmed) → questionnaire + deposit link
// ----------------------------------------------------
app.post("/planyo/callback", express.json(), async (req, res) => {
  try {
    const data = req.body || req.query;
    console.log("📩 Planyo callback:", JSON.stringify(data, null, 2));

    if (data.notification_type === "reservation_confirmed") {
      const bookingID = String(data.reservation);
      console.log(`✅ Reservation confirmed #${bookingID}`);

      if (processedBookings.has(bookingID)) {
        console.log(`⏩ Skip duplicate callback #${bookingID}`);
        return res.status(200).send("Already processed");
      }

      const bk = await fetchPlanyoBooking(bookingID);

      const customerEmail =
        bk.email || data.email || data.user_email || null;
      const customerName = `${bk.firstName || data.first_name || ""} ${
        bk.lastName || data.last_name || ""
      }`.trim();
      const currentStartStr = bk.start || data.start_time || data.from || null;

      if (customerEmail && currentStartStr) {
        try {
          const formType = await decideFormTypeForBooking(
            customerEmail,
            currentStartStr,
            bookingID
          );

          if (!formStatus[bookingID]) {
            formStatus[bookingID] = {
              requiredForm: formType,
              shortDone: false,
              longDone: false,
            };
          } else {
            formStatus[bookingID].requiredForm = formType;
          }
          saveFormStatus();

          await sendQuestionnaireEmail({
            bookingID,
            customerName,
            email: customerEmail,
            formType,
          });
        } catch (e) {
          console.error(
            "❌ Error deciding form type or sending questionnaire:",
            e
          );
        }
      } else {
        console.warn(
          `⚠️ Missing email or start time for booking #${bookingID}, cannot decide LONG/SHORT form`
        );
      }

      await fetch(`${PUBLIC_API_BASE}/deposit/send-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingID, amount: 20000 }),
      });

      processedBookings.add(bookingID);
      saveSet(CALLBACK_FILE, processedBookings);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Planyo callback error:", err);
    res.status(500).send("Error");
  }
});

// ----------------------------------------------------
// Daily scheduler 19:00 London — send links for tomorrow's bookings
// ----------------------------------------------------
if (!global.__DEPOSIT_SCHEDULER_SET__) {
  global.__DEPOSIT_SCHEDULER_SET__ = true;
  cron.schedule("0 19 * * *", async () => {
    console.log(
      "🕓 [AUTO] 19:00 London → Checking upcoming bookings (tomorrow) …"
    );
    await runDepositScheduler("auto");
  });
}

async function runDepositScheduler(mode) {
  try {
    const tz = "Europe/London";
    const now = new Date();
    const lond = new Date(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
        .format(now)
        .replace(
          /(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/,
          "$3-$2-$1T$4:$5:$6"
        )
    );

    const pad = (n) => String(n).padStart(2, "0");
    const fmt = (d) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
        d.getDate()
      )}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
        d.getSeconds()
      )}`;

    const tomorrow = new Date(lond);
    tomorrow.setDate(lond.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const start_time = fmt(tomorrow);
    const end_time = fmt(
      new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000)
    );

    const list = await planyoCall("list_reservations", {
      start_time,
      end_time,
      req_status: 4,
      include_unconfirmed: 1,
    });

    if (!list.json?.data?.results?.length) {
      console.log("ℹ️ Scheduler: no bookings found for tomorrow.");
      return;
    }
    console.log(
      `✅ Scheduler found ${list.json.data.results.length} booking(s)`
    );

    for (const item of list.json.data.results) {
      const bookingID = String(item.reservation_id);

      const details = await planyoCall("get_reservation_data", {
        reservation_id: bookingID,
      });
      const status = details.json?.data?.status;
      if (status !== "7" && status !== 7) {
        console.log(`⏸️ Scheduler skip #${bookingID} (status=${status})`);
        continue;
      }

      await fetch(`${PUBLIC_API_BASE}/deposit/send-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingID, amount: 20000 }),
      });
    }
  } catch (err) {
    console.error("❌ Deposit scheduler error:", err);
  }
}

// ----------------------------------------------------
// Root + Server start
// ----------------------------------------------------
app.get("/", (_req, res) => {
  res.send("🚀 Rental backend running");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`✅ Server running on port ${PORT}`)
);



