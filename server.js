/// server.js
// ----------------------------------------------------
// ✅ Imports and setup
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

const app = express();
app.use(cors());

// ✅ Serve static public files (for thank-you embed)
app.use(express.static("public"));

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
sendgrid.setApiKey(process.env.SENDGRID_API_KEY);

// ⚠️ Do NOT add app.use(express.json()) yet!
// We’ll add it AFTER the Stripe webhook route.

// ---------------------------------------------
// ✅ Stripe Webhook (raw body required for signature verification)
// ---------------------------------------------
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("✅ Stripe webhook event:", event.type);
  res.send();
});

// ✅ Normal middleware only after webhook
app.use(cors());
// ✅ Allow large JSON payloads (up to 20 MB for Base64 PDFs)
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));



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
// ✅ Stripe Webhook (raw body required)
// ---------------------------------------------
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
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

  const pi = event.data.object;

  switch (event.type) {
    case "payment_intent.succeeded":
      console.log("✅ PaymentIntent succeeded:", pi.id);
      break;

    case "payment_intent.payment_failed":
      console.log("❌ PaymentIntent failed:", pi.id);
      break;

    case "payment_intent.canceled":
      console.log("⚠️ PaymentIntent canceled:", pi.id);
      if (pi.metadata && pi.metadata.bookingID) {
        const booking = await fetchPlanyoBooking(pi.metadata.bookingID);
        if (booking.email) {
          const htmlBody = `
            <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333;">
              <img src="https://static.wixstatic.com/media/a9ff84_dfc6008558f94e88a3be92ae9c70201b~mv2.webp"
                   alt="Equine Transport UK"
                   style="width:160px; height:auto; display:block; margin:0 auto 20px auto;" />
              <h2 style="text-align:center; color:#d9534f;">Deposit Hold Canceled</h2>
              <p>Dear ${booking.firstName} ${booking.lastName},</p>
              <p>The deposit hold for <b>Booking #${pi.metadata.bookingID}</b> has been <b>canceled</b>.</p>
              <p>No funds are reserved on your card any longer.</p>
              <hr/>
              <p style="font-size:12px; color:#777; text-align:center;">
                Equine Transport UK<br/>
                Upper Broadreed Farm, Stonehurst Lane, Five Ashes, TN20 6LL<br/>
                📞 +44 7584578654 | ✉️ info@equinetransportuk.com
              </p>
            </div>
          `;

          // Customer email
          await sendgrid.send({
            to: booking.email,
            from: "Equine Transport UK <info@equinetransportuk.com>",
            subject: `Equine Transport UK | Deposit Hold Canceled | Booking #${pi.metadata.bookingID}`,
            html: htmlBody,
          });

          // Admin email
          await sendgrid.send({
            to: "kverhagen@mac.com",
            from: "Equine Transport UK <info@equinetransportuk.com>",
            subject: `Admin Copy | Deposit Hold Canceled | Booking #${pi.metadata.bookingID}`,
            html: htmlBody,
          });
        }
      }
      break;

    case "charge.succeeded":
      console.log("✅ Charge succeeded:", pi.id);
      break;

    case "charge.refunded":
      console.log("💸 Charge refunded:", pi.id);
      if (pi.payment_intent && pi.metadata && pi.metadata.bookingID) {
        const booking = await fetchPlanyoBooking(pi.metadata.bookingID);
        if (booking.email) {
          const htmlBody = `
            <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333;">
              <img src="https://static.wixstatic.com/media/a9ff84_dfc6008558f94e88a3be92ae9c70201b~mv2.webp"
                   alt="Equine Transport UK"
                   style="width:160px; height:auto; display:block; margin:0 auto 20px auto;" />
              <h2 style="text-align:center; color:#28a745;">Deposit Refunded</h2>
              <p>Dear ${booking.firstName} ${booking.lastName},</p>
              <p>Your deposit for <b>Booking #${pi.metadata.bookingID}</b> has been <b>refunded</b>.</p>
              <p>The funds should appear back in your account within 5–10 working days, depending on your bank.</p>
              <hr/>
              <p style="font-size:12px; color:#777; text-align:center;">
                Equine Transport UK<br/>
                Upper Broadreed Farm, Stonehurst Lane, Five Ashes, TN20 6LL<br/>
                📞 +44 7584578654 | ✉️ info@equinetransportuk.com
              </p>
            </div>
          `;

          // Customer email
          await sendgrid.send({
            to: booking.email,
            from: "Equine Transport UK <info@equinetransportuk.com>",
            subject: `Equine Transport UK | Deposit Refunded | Booking #${pi.metadata.bookingID}`,
            html: htmlBody,
          });

          // Admin email
          await sendgrid.send({
            to: "kverhagen@mac.com",
            from: "Equine Transport UK <info@equinetransportuk.com>",
            subject: `Admin Copy | Deposit Refunded | Booking #${pi.metadata.bookingID}`,
            html: htmlBody,
          });
        }
      }
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
// ✅ 1) Terminal connection token
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
// ✅ 2) Create PaymentIntent (manual capture HOLD)
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
    ].filter(Boolean).join(" | ");

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
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------
// ✅ 3) Hosted deposit page (with Full Name input + £200 hold)
// ---------------------------------------------
app.get("/deposit/pay/:bookingID", async (req, res) => {
  const bookingID = req.params.bookingID;
  const amount = 20000; // £200 hold

  const booking = await fetchPlanyoBooking(bookingID);

  // Create initial PaymentIntent (no name yet — will be updated when user submits)
  const intent = await stripe.paymentIntents.create({
    amount,
    currency: "gbp",
    capture_method: "manual",
    payment_method_types: ["card"],
    metadata: { bookingID },
    description: `Booking #${bookingID} | ${booking.firstName} ${booking.lastName} | ${booking.resource}`,
  });

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
  <title>Deposit Hold - Booking ${bookingID}</title>
  <script src="https://js.stripe.com/v3/"></script>
  <style>
  body {
    margin: 0;
    padding: 0;
    background: #f6f7fb;
    font-family: "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    color: #333;
    line-height: 1.6;
    overflow-x: hidden; /* ✅ Prevent horizontal wobble */
  }

  .container {
    max-width: 600px;
    margin: 20px auto;
    background: #fff;
    padding: 16px;
    border-radius: 10px;
    box-sizing: border-box;
  }

  .logo {
    text-align: center;
    margin-bottom: 16px;
  }

  .logo img {
    width: 140px;
    height: auto;
  }

  h2 {
    text-align: center;
    margin: 0 0 10px;
    color: #0070f3;
    font-size: 1.3rem;
  }

  p.center {
    text-align: center;
    margin: 6px 0;
    color: #555;
    word-wrap: break-word;
  }

  label {
    display: block;
    margin-top: 10px;
    font-weight: 600;
    font-size: 0.9rem;
  }

  /* ✅ Inputs and Stripe Elements – smaller, mobile-safe */
  .StripeElement,
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 10px;
    border: 1.5px solid #d8dce6;
    border-radius: 8px;
    background: #fff;
    margin-top: 4px;
    font-size: 15px;
  }

  button {
    margin-top: 16px;
    width: 100%;
    padding: 12px;
    border: 0;
    border-radius: 10px;
    background: #0070f3;
    color: #fff;
    font-size: 16px;
    cursor: pointer;
  }

  #result {
    margin-top: 12px;
    text-align: center;
    font-size: 0.95rem;
  }

  hr {
    margin: 20px 0;
    border: 0;
    border-top: 1px solid #ddd;
  }

  .footer {
    font-size: 12.5px;
    color: #777;
    text-align: center;
    line-height: 1.5;
  }

  .footer a {
    color: #0070f3;
    text-decoration: none;
    font-weight: 500;
  }

  /* ✅ Mobile refinements */
  @media (max-width: 480px) {
    .container {
      margin: 10px;
      padding: 12px;
      border-radius: 8px;
    }
    .StripeElement,
    input {
      padding: 8px;
      font-size: 14px;
    }
    button {
      padding: 10px;
      font-size: 15px;
    }
    h2 {
      font-size: 1.1rem;
    }
  }
</style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <img src="https://planyo-ch.s3.eu-central-2.amazonaws.com/site_logo_68785.png?v=90715" alt="Equine Transport UK Logo"/>
    </div>

    <h2>Deposit Hold (£${(amount/100).toFixed(2)})</h2>
    <p class="center">
      Booking <b>#${bookingID}</b><br/>
      ${booking.firstName} ${booking.lastName}<br/>
      ${booking.resource}<br/>
      ${booking.start} → ${booking.end}
    </p>

    <form id="payment-form">
      <label>Full Name</label>
      <input id="full-name" placeholder="Full Name" required />

      <label>Card Number</label>
      <div id="card-number" class="StripeElement"></div>

      <label>Expiry</label>
      <div id="card-expiry" class="StripeElement"></div>

      <label>CVC</label>
      <div id="card-cvc" class="StripeElement"></div>

      <label>Postcode</label>
      <input id="postal-code" placeholder="Postcode" required />

      <button id="submit">Confirm Hold</button>
      <div id="result"></div>
    </form>

    <hr/>

    <p class="footer">
      <strong>Equine Transport UK</strong><br/>
      Upper Broadreed Farm, Stonehurst Lane, Five Ashes,<br/>
      TN20 6LL, East Sussex, GB<br/>
      📞 +44 7812 188871 | ✉️ 
      <a href="mailto:info@equinetransportuk.com">info@equinetransportuk.com</a>
    </p>
  </div>

  <script>
    const stripe = Stripe("${process.env.STRIPE_PUBLISHABLE_KEY}");
    const clientSecret = "${intent.client_secret}";
    const elements = stripe.elements({ style: { base: { fontSize: "15px", fontFamily:"Helvetica Neue, Arial, sans-serif" } } });

    const cardNumber = elements.create("cardNumber");
    cardNumber.mount("#card-number");
    const cardExpiry = elements.create("cardExpiry");
    cardExpiry.mount("#card-expiry");
    const cardCvc = elements.create("cardCvc");
    cardCvc.mount("#card-cvc");

    const form = document.getElementById("payment-form");
    const resultDiv = document.getElementById("result");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      resultDiv.textContent = "⏳ Processing…";

      const fullName = document.getElementById("full-name").value.trim();
      const postalCode = document.getElementById("postal-code").value.trim();

      if (!fullName) {
        resultDiv.textContent = "⚠️ Please enter your full name.";
        return;
      }

      // ✅ Confirm payment and update metadata with name
      const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
        payment_method: {
          card: cardNumber,
          billing_details: { name: fullName, address: { postal_code: postalCode } }
        }
      });

      if (error) {
        resultDiv.textContent = "❌ " + error.message;
      } else if (paymentIntent && paymentIntent.status === "requires_capture") {
        resultDiv.textContent = "✅ Hold Successful. Redirecting…";

        // ✅ Update metadata to include full name
        fetch("${process.env.SERVER_URL}/update-metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payment_intent_id: paymentIntent.id,
            metadata: { fullName }
          })
        }).catch(()=>{});

        // Trigger confirmation email
        fetch("${process.env.SERVER_URL}/email/deposit-confirmation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingID: "${bookingID}", amount: ${amount} })
        }).catch(()=>{});

        setTimeout(() => {
          window.location.href = "https://www.equinetransportuk.com/thank-you?bookingID=" + ${JSON.stringify(bookingID)} + "&amount=" + ${amount};
        }, 2000);
      } else {
        resultDiv.textContent = "ℹ️ Status: " + paymentIntent.status;
      }
    });
  </script>
</body>
</html>
  `);
});
// ---------------------------------------------
// ✅ 4) Send hosted link via email
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
        <div style="background:#f0f7ff;border:1px solid #d6e7ff;color:#124a8a;padding:12px;border-radius:8px;margin-top:14px;font-size:14px">
          <b>Note:</b> This is a <b>pre-authorisation (hold)</b>. No money is taken now. Funds remain reserved until we release the hold (normally straight after return) or capture part/all if vehicle is returned not refuelled or damaged.
        </div>
        <p style="margin-top:30px;">Kind regards,<br/>Koos & Avril<br/><b>Equine Transport UK</b></p>
        <hr style="margin:30px 0;"/>
        <p style="font-size:12px; color:#777; text-align:center;">
          Equine Transport UK<br/>
          Upper Broadreed Farm, Stonehurst Lane, Five Ashes, TN20 6LL, East Sussex, GB<br/>
          📞 +44 7584578654 | ✉️ <a href="mailto:info@equinetransportuk.com">info@equinetransportuk.com</a>
        </p>
      </div>
    `;

    // Customer email
    await sendgrid.send({
      to: booking.email,
      from: "Equine Transport UK <info@equinetransportuk.com>",
      subject: `Equine Transport UK | Secure Deposit Link | Booking #${bookingID} | ${booking.firstName} ${booking.lastName}`,
      html: htmlBody,
    });

    // Admin email
    await sendgrid.send({
      to: "kverhagen@mac.com",
      from: "Equine Transport UK <info@equinetransportuk.com>",
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
// ✅ 5) List ALL active deposits
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
// ✅ 6) Cancel deposit (with email notifications)
// ---------------------------------------------
app.post("/terminal/cancel", async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    const canceledIntent = await stripe.paymentIntents.cancel(payment_intent_id);
    const bookingID = canceledIntent.metadata?.bookingID;

    console.log(`⚠️ Deposit canceled: ${payment_intent_id} (Booking #${bookingID || "unknown"})`);

    if (bookingID) {
      const booking = await fetchPlanyoBooking(bookingID);

      if (booking.email) {
        const htmlBody = `
          <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333;">
            <img src="https://static.wixstatic.com/media/a9ff84_dfc6008558f94e88a3be92ae9c70201b~mv2.webp"
                 alt="Equine Transport UK"
                 style="width:160px; height:auto; display:block; margin:0 auto 20px auto;" />
            <h2 style="text-align:center; color:#d9534f;">Deposit Hold Canceled</h2>
            <p>Dear ${booking.firstName} ${booking.lastName},</p>
            <p>The deposit hold for <b>Booking #${bookingID}</b> has been <b>canceled</b>.</p>
            <p>No funds are reserved on your card any longer.</p>
            <hr/>
            <p style="font-size:12px; color:#777; text-align:center;">
              <strong>Equine Transport UK</strong><br/>
              Upper Broadreed Farm, Stonehurst Lane, Five Ashes, TN20 6LL<br/>
              📞 +44 7584578654 | ✉️ info@equinetransportuk.com
            </p>
          </div>
        `;

        // ✅ Send email to customer
        await sendgrid.send({
          to: booking.email,
          from: "Equine Transport UK <info@equinetransportuk.com>",
          subject: `Equine Transport UK | Deposit Hold Canceled | Booking #${bookingID}`,
          html: htmlBody,
        });

        // ✅ Send admin copy
        await sendgrid.send({
          to: "kverhagen@mac.com",
          from: "Equine Transport UK <info@equinetransportuk.com>",
          subject: `Admin Copy | Deposit Hold Canceled | Booking #${bookingID}`,
          html: htmlBody,
        });

        console.log(`📩 Cancel emails sent for booking #${bookingID} → ${booking.email} & admin`);
      } else {
        console.warn(`⚠️ No email found for booking #${bookingID}`);
      }
    } else {
      console.warn("⚠️ No bookingID in canceled intent metadata.");
    }

    res.json({ id: canceledIntent.id, status: canceledIntent.status });
  } catch (err) {
    console.error("❌ Cancel error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------
// ✅ Update metadata (for name tracking)
// ---------------------------------------------
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


// ---------------------------------------------
// ✅ 7) Capture deposit
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
// ✅ 10) Check deposit status for a booking (for HireCheck app)
// ---------------------------------------------
app.get("/deposit/status/:bookingID", async (req, res) => {
  try {
    const bookingID = String(req.params.bookingID);
    console.log(`🔎 Checking deposit status for booking #${bookingID}`);

    // List payment intents with this bookingID in metadata
    const paymentIntents = await stripe.paymentIntents.list({ limit: 100 });
    const matching = paymentIntents.data.filter(
      (pi) => pi.metadata && String(pi.metadata.bookingID) === bookingID
    );

    // Find one that’s either captured or holding funds
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



// ---------------------------------------------
// ✅ 9) Deposit confirmation email
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

        <p><b>Note:</b> This is a <b>pre-authorisation (hold)</b>. <b>No money has been taken</b> from your account.</p>

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
          📞 +44 7584578654 | ✉️ <a href="mailto:info@equinetransportuk.com">info@equinetransportuk.com</a>
        </p>
      </div>
    `;

    // Customer email
    await sendgrid.send({
      to: booking.email,
      from: "Equine Transport UK <info@equinetransportuk.com>",
      subject: `Equine Transport UK | Deposit Hold Confirmation #${bookingID} | ${booking.firstName} ${booking.lastName}`,
      html: htmlBody,
    });

    // Admin email
    await sendgrid.send({
      to: "kverhagen@mac.com",
      from: "Equine Transport UK <info@equinetransportuk.com>",
      subject: `Admin Copy | Deposit Hold Confirmation #${bookingID} | ${booking.firstName} ${booking.lastName}`,
      html: htmlBody,
    });

    res.json({ success: true, email: booking.email });
  } catch (err) {
    console.error("❌ SendGrid confirmation error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 📦 Persistent duplicate protection (Render-safe + restart-proof)
// ----------------------------------------------------

// Define storage files (works for both Render Free + Paid plans)
const DATA_DIR = process.env.DATA_DIR || process.cwd();
const SENT_FILE = path.join(DATA_DIR, "sentDeposits.json");
const CALLBACK_FILE = path.join(DATA_DIR, "processedCallbacks.json");

// --- Helpers to load and save sets ---
function loadSet(file) {
  try {
    if (fs.existsSync(file)) {
      const arr = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(arr)) return new Set(arr);
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

// --- Load persisted data ---
let processedBookings = loadSet(CALLBACK_FILE);  // confirmed bookings handled
let sentDepositBookings = loadSet(SENT_FILE);    // deposit links already emailed

// --- Clean up old entries every night (older than 3 days) ---
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
cron.schedule("0 0 * * *", () => {
  const cutoff = Date.now() - THREE_DAYS_MS;
  const cleanSet = new Set(
    [...sentDepositBookings].filter((entry) => {
      const [id, ts] = entry.split(":");
      return !isNaN(Number(ts)) && Number(ts) > cutoff;
    })
  );
  if (cleanSet.size !== sentDepositBookings.size) {
    console.log(
      `🧹 Cleaned old sent deposit entries (${sentDepositBookings.size - cleanSet.size} removed)`
    );
    sentDepositBookings = cleanSet;
    saveSet(SENT_FILE, sentDepositBookings);
  }
});

// --- Utility: mark a booking as sent ---
function markDepositSent(bookingID) {
  sentDepositBookings.add(`${bookingID}:${Date.now()}`);
  saveSet(SENT_FILE, sentDepositBookings);
}

// --- Utility: check if booking was sent recently (within 3 days) ---
function alreadySentRecently(bookingID) {
  const cutoff = Date.now() - THREE_DAYS_MS;
  for (const entry of sentDepositBookings) {
    const [id, ts] = entry.split(":");
    if (id === String(bookingID) && Number(ts) > cutoff) return true;
  }
  return false;
}

// ----------------------------------------------------
// 🔑 Secure Planyo API call with robust timestamp retry
//   - Use UTC epoch for hash_timestamp
//   - On "Invalid timestamp", parse server's current timestamp and retry once
// ----------------------------------------------------
async function planyoCall(method, params = {}) {
  const buildUrl = (timestamp) => {
    const hashBase = process.env.PLANYO_HASH_KEY + timestamp + method;
    const hashKey = crypto.createHash("md5").update(hashBase).digest("hex");
    const query = new URLSearchParams({
      method,
      api_key: process.env.PLANYO_API_KEY,
      site_id: process.env.PLANYO_SITE_ID,
      hash_timestamp: String(timestamp),
      hash_key: hashKey,
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    });
    return `https://www.planyo.com/rest/?${query.toString()}`;
  };

  async function fetchOnce(ts) {
    const url = buildUrl(ts);
    const resp = await fetch(url);
    let text = await resp.text();

    // Try JSON; if HTML or text, keep raw so we can parse error message
    let json;
    try { json = JSON.parse(text); } catch (_) { json = null; }

    return { url, json, text };
  }

  // 1) First attempt with plain UTC epoch
  const firstTs = Math.floor(Date.now() / 1000);
  let { url, json, text } = await fetchOnce(firstTs);

  // 2) If invalid timestamp, parse server's suggested "Current timestamp is NNN" and retry once
 if (json?.response_code === 1 && /Invalid timestamp/i.test(json.response_message || text)) {
  const match = (json.response_message || "").match(/Current timestamp is\s+(\d+)/i);
  if (match && match[1]) {
    const serverTs = parseInt(match[1], 10);
    ({ url, json, text } = await fetchOnce(serverTs));
  }
}

  // If still not JSON, try to surface a helpful error
  if (!json) {
    console.error("❌ Planyo non-JSON response:", text?.slice(0, 300));
    return { url, json: { response_code: 1, response_message: "Non-JSON response from Planyo" } };
  }

  return { url, json };
}


// ----------------------------------------------------
// 🕓 Automatic deposit link scheduler (once daily at 19:00 London time)
// ----------------------------------------------------
if (!global.__DEPOSIT_SCHEDULER_SET__) {
  global.__DEPOSIT_SCHEDULER_SET__ = true; // avoid duplicates on hot reloads

  cron.schedule("0 19 * * *", async () => {
    console.log("🕓 [AUTO] Running once daily at 19:00 (London) → Checking upcoming bookings...");
    await runDepositScheduler("auto");
  });
}

// ⚡ Manual test on startup (enabled only if STARTUP_TEST=true)
if (String(process.env.STARTUP_TEST).toLowerCase() === "true") {
  (async () => {
    console.log("⚡ Manual test: running deposit scheduler immediately... [TEST MODE]");
    await runDepositScheduler("manual");
  })();
}

//// ----------------------------------------------------
// 🧠 Scheduler core function — London-safe + timestamp self-healing
// ----------------------------------------------------
async function runDepositScheduler(mode) {
  try {
    const tz = "Europe/London";
    const now = new Date();

    // Format current London time
    const londonParts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(now)
      .reduce((acc, part) => {
        if (part.type !== "literal") acc[part.type] = part.value;
        return acc;
      }, {});

    const londonNow = new Date(
      `${londonParts.year}-${londonParts.month}-${londonParts.day}T${londonParts.hour}:${londonParts.minute}:${londonParts.second}`
    );

    // Tomorrow window (00:00 → 23:59)
    const tomorrow = new Date(londonNow);
    tomorrow.setDate(londonNow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const formatPlanyoTime = (d) => {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const start_time = formatPlanyoTime(tomorrow);
    const end_time = formatPlanyoTime(new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000));

    console.log(`🕓 London now: ${londonNow.toISOString()} | Checking bookings for ${tomorrow.toDateString()}`);

    // 🔁 Timestamp-safe Planyo list_reservations call
    async function fetchPlanyoList() {
      const zurichNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Zurich" }));
      let timestamp = Math.floor(zurichNow.getTime() / 1000);

      const buildUrl = (ts) => {
        const hashBase = process.env.PLANYO_HASH_KEY + ts + "list_reservations";
        const hashKey = crypto.createHash("md5").update(hashBase).digest("hex");
        return (
          `https://www.planyo.com/rest/?method=list_reservations` +
          `&api_key=${process.env.PLANYO_API_KEY}` +
          `&site_id=${process.env.PLANYO_SITE_ID}` +
          `&start_time=${start_time}` +
          `&end_time=${end_time}` +
          `&req_status=4` +
          `&include_unconfirmed=1` +
          `&hash_timestamp=${ts}` +
          `&hash_key=${hashKey}`
        );
      };

      let url = buildUrl(timestamp);
      let response = await fetch(url);
      let json = await response.json();

      // Retry once if timestamp invalid
      if (json?.response_code === 1 && /Invalid timestamp/i.test(json.response_message)) {
        const match = json.response_message.match(/Current timestamp is (\d+)/);
        if (match && match[1]) {
          timestamp = parseInt(match[1], 10);
          console.warn("⚠️ Invalid timestamp — retrying with corrected timestamp...");
          await new Promise((r) => setTimeout(r, 300));
          url = buildUrl(timestamp);
          response = await fetch(url);
          json = await response.json();
        }
      }

      return { url, json };
    }

    // 🧠 Run the list fetch
    const { url, json: listData } = await fetchPlanyoList();
    console.log(`🌐 Planyo call → ${url}`);

    if (!listData?.data?.results?.length) {
      console.log("ℹ️ No bookings found for tomorrow.");
      return;
    }

    console.log(`✅ Found ${listData.data.results.length} booking(s)`);

    // 🔄 Process each booking safely
    for (const item of listData.data.results) {
      const bookingID = String(item.reservation_id);

      // --- Fetch booking details (with timestamp resync) ---
      async function fetchBookingDetail() {
        const method = "get_reservation_data";
        const zurichNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Zurich" }));
        let ts = Math.floor(zurichNow.getTime() / 1000);
        let hash = crypto.createHash("md5").update(process.env.PLANYO_HASH_KEY + ts + method).digest("hex");

        const buildDetailUrl = (timestamp) =>
          `https://www.planyo.com/rest/?method=${method}` +
          `&api_key=${process.env.PLANYO_API_KEY}` +
          `&site_id=${process.env.PLANYO_SITE_ID}` +
          `&reservation_id=${bookingID}` +
          `&hash_timestamp=${timestamp}` +
          `&hash_key=${crypto.createHash("md5").update(process.env.PLANYO_HASH_KEY + timestamp + method).digest("hex")}`;

        let resp = await fetch(buildDetailUrl(ts));
        let json = await resp.json();

        if (json?.response_code === 1 && /Invalid timestamp/i.test(json.response_message)) {
          const match = json.response_message.match(/Current timestamp is (\d+)/);
          if (match && match[1]) {
            ts = parseInt(match[1], 10);
            console.warn(`⚠️ Booking #${bookingID}: Invalid timestamp — retrying...`);
            await new Promise((r) => setTimeout(r, 200));
            resp = await fetch(buildDetailUrl(ts));
            json = await resp.json();
          }
        }

        return json;
      }

      const bookingData = await fetchBookingDetail();
      const email = bookingData?.data?.email || "unknown";
      const status = bookingData?.data?.status;
      const resource = bookingData?.data?.name || "N/A";

      console.log(`🔍 Booking #${bookingID}: status=${status}, email=${email}`);

      if (status === "7" || status === 7) {
        if (alreadySentRecently(bookingID)) {
          console.log(`⏩ Skipping recent duplicate deposit email for #${bookingID}`);
          continue;
        }

        console.log(`📩 Sending £200 deposit link for booking #${bookingID} (${resource}) → ${email}`);
        await fetch(`${process.env.SERVER_URL}/deposit/send-link`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingID, amount: 20000 }),
        });

        markDepositSent(bookingID);
      } else {
        console.log(`⏸️ Skipped booking #${bookingID} (status=${status})`);
      }
    }
  } catch (err) {
    console.error("❌ Deposit scheduler error:", err);
  }
}


// ----------------------------------------------------
// 📬 Planyo Webhook (Reservation Confirmed)
// ----------------------------------------------------
app.post("/planyo/callback", express.json(), async (req, res) => {
  try {
    const data = req.body || req.query;
    console.log("📩 Planyo callback received:", JSON.stringify(data, null, 2));

    if (data.notification_type === "reservation_confirmed") {
      const bookingID = String(data.reservation);
      const email = data.email;

      console.log(`✅ Reservation confirmed #${bookingID} for ${email}`);

      if (processedBookings.has(bookingID)) {
        console.log(`⏩ Skipping duplicate callback for booking #${bookingID}`);
        return res.status(200).send("Already processed");
      }

      if (alreadySentRecently(bookingID)) {
        console.log(`⏩ Skipping email — deposit already sent recently for #${bookingID}`);
        processedBookings.add(bookingID);
        saveSet(CALLBACK_FILE, processedBookings);
        return res.status(200).send("Deposit already sent");
      }

      await fetch(`${process.env.SERVER_URL}/deposit/send-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingID, amount: 20000 }),
      });

      processedBookings.add(bookingID);
      saveSet(CALLBACK_FILE, processedBookings);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).send("Error");
  }
});


// ----------------------------------------------------
// ✅ Deposit email sender endpoint (sends to customer + admin)
// ----------------------------------------------------
app.post("/deposit/send-link", async (req, res) => {
  try {
    const { bookingID, amount } = req.body;
    const link = `${process.env.SERVER_URL}/deposit/pay/${bookingID}`;

    if (sentDepositBookings.has(String(bookingID))) {
      console.log(`⏩ Skipping duplicate deposit send for booking #${bookingID}`);
      return res.json({ success: true, url: link, alreadySent: true });
    }

    const booking = await fetchPlanyoBooking(bookingID);
    if (!booking.email) return res.status(400).json({ error: "No customer email" });

    const html = `
      <div style="font-family:Arial;line-height:1.5;color:#333;">
        <h2 style="color:#0070f3;text-align:center;">Deposit Payment Request</h2>
        <p>Dear ${booking.firstName} ${booking.lastName},</p>
        <p>Please complete your deposit hold for <b>Booking #${bookingID}</b>.</p>
        <p><b>Lorry:</b> ${booking.resource}<br><b>From:</b> ${booking.start}<br><b>To:</b> ${booking.end}</p>
        <p style="font-size:18px;text-align:center;">Deposit Required: <b>£${(amount / 100).toFixed(2)}</b></p>
        <p style="text-align:center;margin:30px 0;">
          <a href="${link}" style="padding:14px 24px;background:#0070f3;color:#fff;border-radius:6px;text-decoration:none;font-size:16px;">
            💳 Pay Deposit Securely
          </a>
        </p>
        <div style="background:#f0f7ff;border:1px solid #d6e7ff;color:#124a8a;padding:12px;border-radius:8px;margin-top:14px;font-size:14px">
          <b>Note:</b> This is a <b>pre-authorisation (hold)</b>. No money is taken now.
        </div>
        <p style="margin-top:30px;">Kind regards,<br/>Koos & Avril<br/><b>Equine Transport UK</b></p>
        <hr style="margin:30px 0;"/>
        <p style="font-size:12px; color:#777; text-align:center;">
          Equine Transport UK<br/>
          Upper Broadreed Farm, Stonehurst Lane, Five Ashes, TN20 6LL<br/>
          📞 +44 7584578654 | ✉️ info@equinetransportuk.com
        </p>
      </div>`;

    await Promise.all([
      sendgrid.send({
        to: booking.email,
        from: "Equine Transport UK <info@equinetransportuk.com>",
        subject: `Equine Transport UK | Deposit Link | Booking #${bookingID}`,
        html,
      }),
      sendgrid.send({
        to: "kverhagen@mac.com",
        from: "Equine Transport UK <info@equinetransportuk.com>",
        subject: `Admin Copy | Deposit Link | Booking #${bookingID}`,
        html,
      }),
    ]);

    markDepositSent(bookingID);

    console.log(`✅ Deposit link sent to ${booking.email} and admin for booking #${bookingID}`);
    res.json({ success: true, url: link });
  } catch (err) {
    console.error("❌ SendGrid email error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// ✅ Manual trigger route for deposit scheduler
// ----------------------------------------------------
app.get("/trigger-daily-deposits", async (req, res) => {
  try {
    console.log("⚡ Manual deposit scheduler triggered via external cron");
    await runDepositScheduler("manual");
    res.send("✅ Daily deposits triggered remotely");
  } catch (err) {
    console.error("❌ Manual trigger failed:", err);
    res.status(500).send("Error running deposit scheduler");
  }
});

// ✅ Booking Payments — thank-you data route (with auto timestamp resync)
app.get("/bookingpayments/list/:bookingID", async (req, res) => {
  try {
    const { bookingID } = req.params;

    // --- Helper to build signed URL ---
    const buildUrl = (timestamp) => {
      const hashBase = process.env.PLANYO_HASH_KEY + timestamp + "get_reservation_data";
      const hashKey = crypto.createHash("md5").update(hashBase).digest("hex");

      return (
        `https://www.planyo.com/rest/?method=get_reservation_data` +
        `&api_key=${process.env.PLANYO_API_KEY}` +
        `&site_id=${process.env.PLANYO_SITE_ID}` +
        `&reservation_id=${bookingID}` +
        `&hash_timestamp=${timestamp}` +
        `&hash_key=${hashKey}` +
        `&details=1`
      );
    };

    // --- Step 1: Generate initial timestamp (Zurich timezone) ---
    const now = new Date();
    const zurichNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Zurich" }));
    let timestamp = Math.floor(zurichNow.getTime() / 1000);

    // --- Step 2: First API call ---
    let url = buildUrl(timestamp);
    let response = await fetch(url);
    let json = await response.json();

    // --- Step 3: Retry if Planyo says "Invalid timestamp" ---
    if (json?.response_code === 1 && /Invalid timestamp/i.test(json.response_message)) {
      console.warn("⚠️ Invalid timestamp — retrying with corrected timestamp...");

      const match = json.response_message.match(/Current timestamp is (\d+)/);
      if (match && match[1]) {
        timestamp = parseInt(match[1], 10);
        url = buildUrl(timestamp);
        response = await fetch(url);
        json = await response.json();
      }
    }

    // --- Step 4: Parse result ---
    if (json?.response_code === 0 && json.data) {
      const r = json.data;

      return res.json({
        bookingID,
        customer: `${r.first_name} ${r.last_name}`,
        resource: r.name,
        start: r.start_time,
        end: r.end_time,
        total: parseFloat(r.total_price || 0).toFixed(2),
        paid: parseFloat(r.amount_paid || 0).toFixed(2),
        balance: parseFloat((r.total_price || 0) - (r.amount_paid || 0)).toFixed(2),
      });
    }

    console.error("❌ Invalid Planyo response:", json);
    return res.status(500).json({ error: "Invalid Planyo response", raw: json });

  } catch (err) {
    console.error("Booking fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// ✅ Booking Thank-You Proxy (for Wix embed)
// ----------------------------------------------------
app.get("/booking-thankyou-proxy", (req, res) => {
  const query = req.url.split("?")[1] || "";
  const url = `https://rental-backend-0kz1.onrender.com/thankyou-embed.html?${query}`;
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta http-equiv="refresh" content="0; url=${url}">
        <script>window.location.replace("${url}");</script>
      </head>
      <body>
        Redirecting to thank-you page...
      </body>
    </html>
  `);
});


// ----------------------------------------------------
// 📧 Send Damage Report Email (to customer + admin)
// ----------------------------------------------------

sendgrid.setApiKey(process.env.SENDGRID_API_KEY);

app.post("/damage/send-report", express.json({ limit: "20mb" }), async (req, res) => {
  try {
    const { bookingID, customerEmail, pdfBase64 } = req.body;

    if (!bookingID || !customerEmail || !pdfBase64) {
      return res.status(400).json({ error: "Missing bookingID, email, or PDF data" });
    }

    const pdfBuffer = Buffer.from(pdfBase64, "base64");

    const attachments = [
      {
        content: pdfBase64,
        filename: `DamageReport_${bookingID}.pdf`,
        type: "application/pdf",
        disposition: "attachment",
      },
    ];

    const htmlBody = `
      <div style="font-family:Helvetica,Arial,sans-serif;color:#333;background:#f9f9f9;padding:30px;">
        <div style="text-align:center;margin-bottom:25px;">
          <img src="https://planyo-ch.s3.eu-central-2.amazonaws.com/site_logo_68785.png?v=90715"
               alt="Equine Transport UK" width="220" />
        </div>

        <h2 style="color:#2b2b2b;">Pick-Up Damage & Fuel Report</h2>
        <p>Dear Customer,</p>
        <p>
          Please find attached your Pick-Up Damage & Fuel Report for booking <b>#${bookingID}</b>.
        </p>
        <p>Kind regards,<br><strong>Equine Transport UK</strong></p>

        <hr style="margin:30px 0;border:none;border-top:1px solid #ddd;" />
        <p style="font-size:12px;color:#666;text-align:center;">
          Equine Transport UK · The Millens · East Sussex ·
          <a href="mailto:info@equinetransportuk.com" style="color:#666;">info@equinetransportuk.com</a>
        </p>
      </div>
    `;

    await sendgrid.send({
      to: [customerEmail, "info@equinetransportuk.com"], // 👈 both copies
      from: {
        email: "info@equinetransportuk.com",
        name: "Equine Transport UK",
      },
      subject: `Damage / Fuel Report – Booking #${bookingID}`,
      html: htmlBody,
      attachments,
    });

    console.log(`✅ Damage report emailed for booking ${bookingID}`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ SendGrid email error:", err.response?.body || err);
    res.status(500).json({ error: "Email failed to send" });
  }
});


// ----------------------------------------------------
// ✅ List upcoming + in-progress bookings for HireCheck
// ----------------------------------------------------
app.get("/planyo/upcoming", async (req, res) => {
  try {
    const now = new Date();
    const threeDaysLater = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const formatPlanyoTime = (d) => {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const start_time = formatPlanyoTime(now);
    const end_time = formatPlanyoTime(threeDaysLater);
    const method = "list_reservations";

    async function fetchList(ts) {
      const hash = crypto.createHash("md5").update(process.env.PLANYO_HASH_KEY + ts + method).digest("hex");
      const url =
        `https://www.planyo.com/rest/?method=${method}` +
        `&api_key=${process.env.PLANYO_API_KEY}` +
        `&site_id=${process.env.PLANYO_SITE_ID}` +
        `&start_time=${start_time}` +
        `&end_time=${end_time}` +
        `&req_status=4` +
        `&include_unconfirmed=1` +
        `&hash_timestamp=${ts}` +
        `&hash_key=${hash}`;

      const resp = await fetch(url);
      const text = await resp.text();

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { url, json, text };
    }

    // --- Initial call ---
    const firstTs = Math.floor(Date.now() / 1000);
    let { json, text } = await fetchList(firstTs);

    // --- Retry if timestamp invalid ---
    if (json?.response_code === 1 && /Invalid timestamp/i.test(json.response_message || text)) {
      const match = (json.response_message || "").match(/Current timestamp is\s+(\d+)/i);
      if (match && match[1]) {
        const correctedTs = parseInt(match[1], 10);
        console.warn(`⚠️ Invalid timestamp — retrying with corrected timestamp ${correctedTs}`);
        ({ json, text } = await fetchList(correctedTs));
      }
    }

    if (!json?.data?.results?.length) {
      return res.json([]);
    }

    const bookings = json.data.results.map((b) => ({
      bookingID: String(b.reservation_id),
      vehicleName: b.name || "—",
      startDate: b.start_time || "",
      endDate: b.end_time || "",
      customerName: `${b.first_name || ""} ${b.last_name || ""}`.trim(),
      email: b.email || "",
      phoneNumber: b.phone || "",
      totalPrice: b.total_price || "",
      amountPaid: b.amount_paid || "",
      addressLine1: b.address_line_1 || "",
      addressLine2: b.address_line_2 || "",
      postcode: b.zip || "",
      dateOfBirth: b.birth_date || ""
    }));

    res.json(bookings);
  } catch (err) {
    console.error("❌ Failed to fetch upcoming bookings:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// ✅ Get full booking details including custom form fields
// ----------------------------------------------------
app.get("/planyo/booking/:bookingID", async (req, res) => {
  try {
    const bookingID = req.params.bookingID;
    const method = "get_reservation_data";
    const firstTs = Math.floor(Date.now() / 1000);

    async function fetchBooking(ts) {
      const hash = crypto
        .createHash("md5")
        .update(process.env.PLANYO_HASH_KEY + ts + method)
        .digest("hex");

      // include_form_items=1 ensures we get all custom fields like phone/address/DOB
      const url =
        `https://www.planyo.com/rest/?method=${method}` +
        `&api_key=${process.env.PLANYO_API_KEY}` +
        `&site_id=${process.env.PLANYO_SITE_ID}` +
        `&reservation_id=${bookingID}` +
        `&include_form_items=1` +
        `&hash_timestamp=${ts}` +
        `&hash_key=${hash}`;

      const resp = await fetch(url);
      const text = await resp.text();

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { json, text };
    }

    let { json, text } = await fetchBooking(firstTs);

    if (json?.response_code === 1 && /Invalid timestamp/i.test(json.response_message || text)) {
      const match = (json.response_message || "").match(/Current timestamp is\s+(\d+)/i);
      if (match && match[1]) {
        const correctedTs = parseInt(match[1], 10);
        console.warn(`⚠️ Invalid timestamp — retrying with corrected timestamp ${correctedTs}`);
        ({ json, text } = await fetchBooking(correctedTs));
      }
    }

    if (!json?.data) {
      console.error("❌ No valid data from Planyo:", text);
      return res.status(404).json({ error: "No data returned", raw: text });
    }

    const b = json.data;
    const formItems = b.form_items || {};

    const booking = {
      bookingID,
      vehicleName: b.name || b.resource_name || "—",
      startDate: b.start_time || "",
      endDate: b.end_time || "",
      customerName: `${b.first_name || ""} ${b.last_name || ""}`.trim(),
      email: b.email || "",
      phoneNumber:
        b.phone ||
        b.mobile ||
        formItems.phone ||
        formItems["Phone number"] ||
        formItems["Mobile"] ||
        "",
      totalPrice: b.total_price || "",
      amountPaid: b.amount_paid || "",
      addressLine1:
        b.address_line_1 ||
        formItems["Address line 1"] ||
        formItems["Address"] ||
        "",
      addressLine2: b.address_line_2 || formItems["Address line 2"] || "",
      postcode: b.zip || formItems["Postcode"] || "",
      dateOfBirth: formItems["Date of birth"] || formItems["DOB"] || "",
    };

    res.json(booking);
  } catch (err) {
    console.error("❌ Failed to fetch booking details:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 🚀 Start server
// ----------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));