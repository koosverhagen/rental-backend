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
// ✅ 3) Hosted deposit page (with redirect + £400 hold)
// ---------------------------------------------
app.get("/deposit/pay/:bookingID", async (req, res) => {
  const bookingID = req.params.bookingID;
  const amount = 100; // £400 hold

  const booking = await fetchPlanyoBooking(bookingID);

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
      margin:0; padding:0;
      background:#f6f7fb;
      font-family:"Helvetica Neue", Arial, sans-serif;
      font-size:13px; color:#333;
      line-height:1.6;
    }
    .container {
      max-width:600px; margin:30px auto;
      background:#fff; padding:20px;
      border-radius:8px;
    }
    .logo { text-align:center; margin-bottom:20px; }
    .logo img { width:160px; height:auto; }
    h2 {
      text-align:center; margin:0 0 12px;
      color:#0070f3;
    }
    p.center { text-align:center; margin:6px 0; color:#555; }
    label { display:block; margin-top:12px; font-weight:600; }
    .StripeElement, input {
      padding:12px; border:2px solid #e6e8ef; border-radius:8px;
      background:#fff; margin-top:6px; font-size:14px;
    }
    button {
      margin-top:18px; width:100%;
      padding:14px; border:0;
      border-radius:10px;
      background:#0070f3; color:#fff;
      font-size:16px; cursor:pointer;
    }
    #result { margin-top:14px; text-align:center; }
    hr { margin:24px 0; border:0; border-top:1px solid #ccc; }
    .footer {
      font-size:13px; color:#777; text-align:center;
      line-height:1.5; font-weight:300;
    }
    .footer a {
      color:#0070f3; text-decoration:none; font-weight:500;
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
      <label>Card Number</label>
      <div id="card-number" class="StripeElement"></div>

      <label>Expiry</label>
      <div id="card-expiry" class="StripeElement"></div>

      <label>CVC</label>
      <div id="card-cvc" class="StripeElement"></div>

      <label>Postcode</label>
      <input id="postal-code" placeholder="Postcode"/>

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

      const postalCode = document.getElementById("postal-code").value;
      const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
        payment_method: {
          card: cardNumber,
          billing_details: { address: { postal_code: postalCode } }
        }
      });

      if (error) {
        resultDiv.textContent = "❌ " + error.message;
      } else if (paymentIntent && paymentIntent.status === "requires_capture") {
        resultDiv.textContent = "✅ Hold Successful. Redirecting…";

        // Trigger confirmation email
        fetch("${process.env.SERVER_URL}/email/deposit-confirmation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingID: "${bookingID}", amount: ${amount} })
        }).catch(()=>{});

       // 🔥 Redirect after 2 seconds — correctly pass bookingID and amount
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
          <b>Note:</b> This is a <b>pre-authorisation (hold)</b>. No money is taken now. Funds remain reserved until we
          release the hold (normally within 7 days of return) or capture part/all if required by your hire agreement.
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
// ✅ 6) Cancel deposit
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

// ---------------------------------------------
// 🕓 Automatic deposit link scheduler (Planyo → Email via /deposit/send-link)
// TEST MODE – Admin Only (until 1 Nov)
// ---------------------------------------------
const cron = require("node-cron");

// Run every day at 18:00 (6PM) UTC (Render runs in UTC by default)
cron.schedule("0 18 * * *", async () => {
  console.log("🕕 [TEST MODE – Admin Only] Checking upcoming bookings for automatic deposit emails...");

  try {
    const method = "list_reservations"; // ✅ Works for site-level API keys
    const timestamp = Math.floor(Date.now() / 1000);
    const raw = process.env.PLANYO_HASH_KEY + timestamp + method;
    const hashKey = crypto.createHash("md5").update(raw).digest("hex");

    // Tomorrow in UTC
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    // Convert start/end to UTC UNIX timestamps (Planyo expects UTC)
    const startOfDay = Date.UTC(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth(),
      tomorrow.getUTCDate(),
      0, 0, 0
    ) / 1000;

    const endOfDay = Date.UTC(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth(),
      tomorrow.getUTCDate(),
      23, 59, 59
    ) / 1000;

    const url =
      `https://www.planyo.com/rest/?method=${method}` +
      `&api_key=${process.env.PLANYO_API_KEY}` +
      `&from=${Math.floor(startOfDay)}` +
      `&to=${Math.floor(endOfDay)}` +
      `&include_unconfirmed=1` +
      `&hash_timestamp=${timestamp}` +
      `&hash_key=${hashKey}`;

    console.log("🌐 Fetching from Planyo:", url);
    const resp = await fetch(url);
    const data = await resp.json();
    console.log("🧾 Raw Planyo API response:", JSON.stringify(data, null, 2));

    if (data && data.response_code === 0 && Array.isArray(data.data) && data.data.length > 0) {
      for (const booking of data.data) {
        const bookingID = booking.reservation_id;
        const amount = 100; // £1 test hold

        console.log(`📩 [TEST MODE – Admin Only] Auto-sending deposit link for booking #${bookingID}`);

        await fetch(`${process.env.SERVER_URL}/deposit/send-link`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingID,
            amount,
            adminOnly: true, // 🚫 only send to admin until 1 Nov
          }),
        });
      }
    } else {
      console.log("ℹ️ No bookings found for tomorrow in automatic run.");
    }
  } catch (err) {
    console.error("❌ Auto-deposit email error:", err);
  }
});

// ---------------------------------------------
// ⚡ Manual test (runs once on startup)
// ---------------------------------------------
(async () => {
  console.log("⚡ Manual test: running deposit scheduler immediately... [TEST MODE – Admin Only]");
  try {
    const method = "list_reservations"; // ✅ site-level friendly
    const timestamp = Math.floor(Date.now() / 1000);
    const raw = process.env.PLANYO_HASH_KEY + timestamp + method;
    const hashKey = crypto.createHash("md5").update(raw).digest("hex");

    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    // Convert start/end to UTC UNIX timestamps (Planyo expects UTC)
    const startOfDay = Date.UTC(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth(),
      tomorrow.getUTCDate(),
      0, 0, 0
    ) / 1000;

    const endOfDay = Date.UTC(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth(),
      tomorrow.getUTCDate(),
      23, 59, 59
    ) / 1000;

    const url =
      `https://www.planyo.com/rest/?method=${method}` +
      `&api_key=${process.env.PLANYO_API_KEY}` +
      `&from=${Math.floor(startOfDay)}` +
      `&to=${Math.floor(endOfDay)}` +
      `&include_unconfirmed=1` +
      `&hash_timestamp=${timestamp}` +
      `&hash_key=${hashKey}`;

    console.log("🌐 Fetching from Planyo:", url);
    const resp = await fetch(url);
    const data = await resp.json();
    console.log("🧾 Raw Planyo API response:", JSON.stringify(data, null, 2));

    if (data && data.response_code === 0 && Array.isArray(data.data) && data.data.length > 0) {
      for (const booking of data.data) {
        const bookingID = booking.reservation_id;
        const amount = 100; // £1 test hold
        console.log(`⚡ [TEST MODE – Admin Only] Sending immediate test email for booking #${bookingID}`);

        await fetch(`${process.env.SERVER_URL}/deposit/send-link`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingID,
            amount,
            adminOnly: true, // 🚫 only send to admin during test
          }),
        });
      }
    } else {
      console.log("ℹ️ No bookings found for tomorrow in manual test.");
    }
  } catch (err) {
    console.error("❌ Manual test error:", err);
  }
})();


// ---------------------------------------------
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
