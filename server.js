// server.js
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const fetch = require("node-fetch");
const crypto = require("crypto");
const sendgrid = require("@sendgrid/mail");
require("dotenv").config();

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ SendGrid with API key
sendgrid.setApiKey(process.env.SENDGRID_API_KEY);

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

// ---------------------------------------------
// ✅ Stripe Webhook (raw body required, must come BEFORE express.json())
// ---------------------------------------------
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw Buffer
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "payment_intent.succeeded":
      console.log("✅ PaymentIntent succeeded:", event.data.object.id);
      break;
    case "payment_intent.payment_failed":
      console.log("❌ PaymentIntent failed:", event.data.object.id);
      break;
    default:
      console.log(`ℹ️ Unhandled event type: ${event.type}`);
  }

  res.send();
});

// ✅ Apply middlewares AFTER webhook
app.use(cors());
app.use(express.json());

// ---------------------------------------------
// ✅ 1) Terminal connection token (if ever needed)
// ---------------------------------------------
app.post("/terminal/connection_token", async (_req, res) => {
  try {
    const connectionToken = await stripe.terminal.connectionTokens.create();
    res.json({ secret: connectionToken.secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------
// ✅ 2) Create PaymentIntent (manual capture HOLD) — API use
// ---------------------------------------------
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
      capture_method: "manual", // 👈 HOLD, not immediate charge
      payment_method_types: ["card"],
      metadata: { bookingID },
      description,
    });

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------
// ✅ 3) Hosted deposit page with full Stripe Elements form
// ---------------------------------------------
app.get("/deposit/pay/:bookingID", async (req, res) => {
  const bookingID = req.params.bookingID;
  const amount = 100; // £1 test hold — adjust as needed

  const booking = await fetchPlanyoBooking(bookingID);

  const intent = await stripe.paymentIntents.create({
    amount,
    currency: "gbp",
    capture_method: "manual", // 👈 HOLD
    payment_method_types: ["card"],
    metadata: { bookingID },
    description: `Booking #${bookingID} | ${booking.firstName} ${booking.lastName} | ${booking.resource}`,
  });

  res.send(`<!DOCTYPE html> ... (UNCHANGED HTML/JS CONTENT) ...`);
});

// ---------------------------------------------
// ✅ 4) Send hosted link via email (styled, customer + admin)
// ---------------------------------------------
app.post("/deposit/send-link", async (req, res) => {
  try {
    const { bookingID, amount, locationId } = req.body;
    const booking = await fetchPlanyoBooking(bookingID);

    if (!booking.email) {
      return res.status(400).json({ error: "No customer email found" });
    }

    const link = `${process.env.SERVER_URL}/deposit/pay/${bookingID}`;
    console.log("👉 Deposit link requested:", bookingID, amount, locationId);

    const logo = `
      <div style="text-align:center; margin-bottom:20px;">
        <img src="https://static.wixstatic.com/media/a9ff84_dfc6008558f94e88a3be92ae9c70201b~mv2.webp"
             alt="Equine Transport UK" style="width:160px; height:auto;" />
      </div>
    `;

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; line-height:1.5; color:#333;">
        ${logo}
        <h2 style="text-align:center; color:#0070f3;">Deposit Payment Request</h2>
        <p>Dear ${booking.firstName} ${booking.lastName},</p>
        <p>Please complete your deposit hold for <b>Booking #${bookingID}</b>.</p>
        <p>
          <b>Lorry:</b> ${booking.resource}<br/>
          <b>From:</b> ${booking.start}<br/>
          <b>To:</b> ${booking.end}
        </p>
        <p style="font-size:18px; text-align:center;">
          Deposit Required: <b>£${(amount/100).toFixed(2)}</b>
        </p>
        <div style="text-align:center; margin:30px 0;">
          <a href="${link}"
             style="padding:14px 22px; background:#0070f3; color:#fff; border-radius:6px; text-decoration:none; font-size:16px;">
            💳 Pay Deposit Securely
          </a>
        </div>
        <p style="margin-top:30px;">Kind regards,<br/>Koos & Avril<br/><b>Equine Transport UK</b></p>
        <hr style="margin:30px 0;"/>
        <p style="font-size:12px; color:#777; text-align:center;">
          Equine Transport UK<br/>
          Upper Broadreed Farm, Stonehurst Lane, Five Ashes, TN20 6LL, East Sussex, GB<br/>
          📞 +44 7584578654 | ✉️ <a href="mailto:kverhagen@mac.com">kverhagen@mac.com</a>
        </p>
      </div>
    `;

    // Customer email (styled)
    await sendgrid.send({
      to: booking.email,
      from: "Equine Transport UK <kverhagen@mac.com>",
      subject: `Equine Transport UK | Secure Deposit Link | Booking #${bookingID} | ${booking.firstName} ${booking.lastName}`,
      html: htmlBody,
    });

    // Admin email
    await sendgrid.send({
      to: "kverhagen@mac.com",
      from: "Equine Transport UK <kverhagen@mac.com>",
      subject: `Admin Copy | Deposit Link Sent | Booking #${bookingID} | ${booking.firstName} ${booking.lastName}`,
      html: htmlBody,
    });

    res.json({ success: true, url: link, locationId });
  } catch (err) {
    console.error("❌ SendGrid email error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------
// ✅ 5) List ALL active deposits (renames requires_capture → Hold Successful)
// ---------------------------------------------
app.get("/terminal/list-all", async (_req, res) => {
  try {
    const paymentIntents = await stripe.paymentIntents.list({ limit: 50 });
    const deposits = [];

    for (const pi of paymentIntents.data) {
      if (pi.metadata && pi.metadata.bookingID && pi.status === "requires_capture") {
        const booking = await fetchPlanyoBooking(pi.metadata.bookingID);
        deposits.push({
          id: pi.id,
          bookingID: pi.metadata.bookingID,
          amount: pi.amount,
          status: "Hold Successful",
          created: pi.created,
          name: booking.resource,
          start: booking.start,
          end: booking.end,
          customer: `${booking.firstName} ${booking.lastName}`.trim(),
        });
      }
    }

    res.json(deposits);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------
// ✅ 6) Cancel deposit (cancel PI)
// ---------------------------------------------
app.post("/terminal/cancel", async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    const canceledIntent = await stripe.paymentIntents.cancel(payment_intent_id);
    res.json({ id: canceledIntent.id, status: canceledIntent.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------
// ✅ 7) Capture deposit (capture PI)
// ---------------------------------------------
app.post("/terminal/capture", async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    const capturedIntent = await stripe.paymentIntents.capture(payment_intent_id);
    res.json(capturedIntent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------
// ✅ 8) List deposits for a single booking
// ---------------------------------------------
app.get("/terminal/list/:bookingID", async (req, res) => {
  try {
    const bookingID = String(req.params.bookingID);
    const paymentIntents = await stripe.paymentIntents.list({ limit: 100 });

    const deposits = paymentIntents.data.filter(
      (pi) => pi.metadata && String(pi.metadata.bookingID) === bookingID
    );

    const booking = await fetchPlanyoBooking(bookingID);

    const result = deposits.map((pi) => ({
      id: pi.id,
      bookingID,
      amount: pi.amount,
      status: pi.status === "requires_capture" ? "Hold Successful" : pi.status,
      created: pi.created,
      name: booking.resource,
      start: booking.start,
      end: booking.end,
      customer: `${booking.firstName} ${booking.lastName}`.trim(),
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------
// ✅ 9) Send deposit confirmation email (styled & explains HOLD)
// ---------------------------------------------
app.post("/email/deposit-confirmation", async (req, res) => {
  try {
    const { bookingID, amount } = req.body;
    const booking = await fetchPlanyoBooking(bookingID);

    if (!booking.email) {
      return res.status(400).json({ error: "Could not find customer email" });
    }

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333;">
        <img src="https://static.wixstatic.com/media/a9ff84_dfc6008558f94e88a3be92ae9c70201b~mv2.webp"
             alt="Equine Transport UK"
             style="width:160px; height:auto; display:block; margin:0 auto 20px auto;" />

        <h2 style="text-align:center; color:#0070f3;">Deposit Hold Confirmation</h2>

        <p><b>⚠️ Note:</b> This is a <b>pre-authorisation (hold)</b>. <b>No money has been taken</b> from your account.</p>

        <p>Dear ${booking.firstName} ${booking.lastName},</p>
        <p>We have successfully placed a deposit hold of <b>£${(amount/100).toFixed(2)}</b> for your booking <b>#${bookingID}</b>.</p>

        <h3>Booking Details</h3>
        <ul>
          <li><b>Lorry:</b> ${booking.resource}</li>
          <li><b>From:</b> ${booking.start}</li>
          <li><b>To:</b> ${booking.end}</li>
          <li><b>Customer:</b> ${booking.firstName} ${booking.lastName}</li>
          <li><b>Email:</b> ${booking.email}</li>
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
          📞 +44 7584578654 | ✉️ <a href="mailto:kverhagen@mac.com">kverhagen@mac.com</a>
        </p>
      </div>
    `;

    await sendgrid.send({
      to: [booking.email, "kverhagen@mac.com"], // customer + admin copy
      from: "Equine Transport UK <kverhagen@mac.com>",  // 👈 branded From
      subject: `Equine Transport UK | Deposit Hold Confirmation #${bookingID} | ${booking.firstName} ${booking.lastName}`,
      html: htmlBody,
    });

    res.json({ success: true, email: booking.email });
  } catch (err) {
    console.error("❌ SendGrid confirmation error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
