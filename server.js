// server.js
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");
const fetch = require("node-fetch");
const crypto = require("crypto"); // ✅ needed for Planyo hash auth
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: { rejectUnauthorized: false }, // 👈 allow Render to connect without cert issues
  connectionTimeout: 10000,           // 👈 10s timeout instead of hanging
});

// ---------------------------------------------
// 🔧 Helper: fetch booking info from Planyo
// ---------------------------------------------
async function fetchPlanyoBooking(bookingID) {
  try {
    const method = "get_reservation_data";
    const timestamp = Math.floor(Date.now() / 1000);
    const raw = process.env.PLANYO_HASH_KEY + timestamp + method;
    const hashKey = crypto.createHash("md5").update(raw).digest("hex");

    const url =
      `https://www.planyo.com/rest/?method=${method}` +
      `&api_key=${process.env.PLANYO_API_KEY}` +
      `&reservation_id=${bookingID}` +
      `&hash_timestamp=${timestamp}` +
      `&hash_key=${hashKey}`;

    const resp = await fetch(url);
    const data = await resp.json();

    if (data && data.response_code === 0 && data.data) {
      return {
        resource: data.data.name || "N/A",
        start: data.data.start_time || "N/A",
        end: data.data.end_time || "N/A",
        firstName: data.data.first_name || "",
        lastName: data.data.last_name || "",
        email: data.data.email || null,
      };
    }
  } catch (err) {
    console.error("⚠️ Planyo fetch error:", err);
  }
  return {
    resource: "N/A",
    start: "N/A",
    end: "N/A",
    firstName: "",
    lastName: "",
    email: null,
  };
}

// ✅ 1. Create connection token (for Tap to Pay if ever needed)
app.post("/terminal/connection_token", async (req, res) => {
  try {
    const connectionToken = await stripe.terminal.connectionTokens.create();
    res.json({ secret: connectionToken.secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 2. Create PaymentIntent (manual capture HOLD)
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
      capture_method: "manual", // 👈 HOLD
      payment_method_types: ["card"],
      metadata: { bookingID },
      description,
    });

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 3. Serve hosted deposit entry page
app.get("/deposit/pay/:bookingID", async (req, res) => {
  const bookingID = req.params.bookingID;
  const amount = 100; // £1 hold

  const booking = await fetchPlanyoBooking(bookingID);

  const intent = await stripe.paymentIntents.create({
    amount,
    currency: "gbp",
    capture_method: "manual", // 👈 HOLD
    payment_method_types: ["card"],
    metadata: { bookingID },
    description: `Booking #${bookingID} | ${booking.firstName} ${booking.lastName} | ${booking.resource}`,
  });

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>…</head>
    <body>…</body>
    </html>
  `);
});

// ✅ 4. Send hosted link via email
app.post("/deposit/send-link", async (req, res) => {
  try {
    const { bookingID, amount, locationId } = req.body;
    const booking = await fetchPlanyoBooking(bookingID);

    if (!booking.email) {
      return res.status(400).json({ error: "No customer email found" });
    }

    const link = `${process.env.SERVER_URL}/deposit/pay/${bookingID}`;

    console.log("👉 Deposit link requested:");
    console.log("   BookingID:", bookingID);
    console.log("   Amount:", amount);
    console.log("   LocationID:", locationId);

    const logo = `<div style="text-align:center; margin-bottom:20px;">
        <img src="https://static.wixstatic.com/media/a9ff84_dfc6008558f94e88a3be92ae9c70201b~mv2.webp"
             alt="Equine Transport UK"
             style="width:160px; height:auto;" />
      </div>`;

    // Customer email
    await transporter.sendMail({
      from: `"Equine Transport UK" <${process.env.SMTP_USER}>`,
      to: booking.email,
      subject: `Equine Transport UK | Secure Deposit Link | Booking #${bookingID}`,
      html: `${logo}<p>Booking <b>#${bookingID}</b></p>
             <p>Deposit: <b>£${amount / 100}</b></p>
             <p>Location ID: ${locationId || "N/A"}</p>
             <p><a href="${link}">💳 Pay Deposit</a></p>`,
    });

    // Admin email
    await transporter.sendMail({
      from: `"Equine Transport UK" <${process.env.SMTP_USER}>`,
      to: "kverhagen@mac.com",
      subject: `Admin Copy | Deposit Link for Booking #${bookingID}`,
      html: `${logo}<p>Booking <b>#${bookingID}</b></p>
             <p>Deposit: <b>£${amount / 100}</b></p>
             <p>Location ID: ${locationId || "N/A"}</p>
             <p><a href="${link}">💳 Pay Deposit</a></p>`,
    });

    res.json({ success: true, url: link, locationId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 5. List ALL active deposits
app.get("/terminal/list-all", async (req, res) => { … });

// ✅ 6. Cancel deposit
app.post("/terminal/cancel", async (req, res) => { … });

// ✅ 7. Capture deposit
app.post("/terminal/capture", async (req, res) => { … });

// ✅ 8. List deposits for a single booking
app.get("/terminal/list/:bookingID", async (req, res) => { … });

// ✅ Send deposit confirmation email
app.post("/email/deposit-confirmation", async (req, res) => { … });

// ✅ Stripe Webhook Handler
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => { … });

// ✅ Planyo Callback Handler
app.post("/planyo-callback", (req, res) => { … });


// ✅ NEW: Simple test route for SMTP
app.get("/test/email", async (req, res) => {
  try {
    const info = await transporter.sendMail({
      from: `"Equine Transport UK" <${process.env.SMTP_USER}>`,
      to: "kverhagen@mac.com",
      subject: "Test Email from Render Backend",
      text: "This is a test email sent from your rental-backend service on Render."
    });

    console.log("📧 Test email sent:", info);
    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    console.error("❌ Email send failed:", err);
    res.status(500).json({ error: err.message });
  }
});


// ---------------------------------------------
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
