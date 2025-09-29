// server.js
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const fetch = require("node-fetch");
const crypto = require("crypto");
const sendgrid = require("@sendgrid/mail");
require("dotenv").config();

const app = express();
app.use(cors());

// ⚠️ Do not use express.json() before webhook — Stripe needs raw body first
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Configure SendGrid
sendgrid.setApiKey(process.env.SMTP_PASS); // store SendGrid API key in SMTP_PASS

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
// ✅ Stripe Webhook Handler (raw body required)
// ---------------------------------------------
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
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

// ✅ Apply express.json() AFTER webhook
app.use(express.json());

// ---------------------------------------------
// ✅ 1. Create connection token
// ---------------------------------------------
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

// ✅ 3. Hosted deposit entry page
app.get("/deposit/pay/:bookingID", async (req, res) => {
  const bookingID = req.params.bookingID;
  const amount = 100; // test hold
  const booking = await fetchPlanyoBooking(bookingID);

  const intent = await stripe.paymentIntents.create({
    amount,
    currency: "gbp",
    capture_method: "manual",
    payment_method_types: ["card"],
    metadata: { bookingID },
    description: `Booking #${bookingID} | ${booking.firstName} ${booking.lastName} | ${booking.resource}`,
  });

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Deposit Hold - Booking ${bookingID}</title>
  <script src="https://js.stripe.com/v3/"></script>
</head>
<body>
  <h2>Deposit Hold (£${amount / 100})</h2>
  <p>Booking <b>#${bookingID}</b> - ${booking.firstName} ${booking.lastName}</p>
  <form id="payment-form">
    <div id="card-element"></div>
    <button id="submit">Confirm Hold</button>
  </form>
  <div id="result"></div>
  <script>
    const stripe = Stripe("${process.env.STRIPE_PUBLISHABLE_KEY}");
    const elements = stripe.elements();
    const card = elements.create("card");
    card.mount("#card-element");
    const form = document.getElementById("payment-form");
    const resultDiv = document.getElementById("result");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const {error, paymentIntent} = await stripe.confirmCardPayment("${intent.client_secret}", {
        payment_method: { card: card }
      });
      if (error) {
        resultDiv.innerText = "❌ " + error.message;
      } else {
        resultDiv.innerText = "✅ Hold Successful";
      }
    });
  </script>
</body>
</html>`);
});

// ✅ 4. Send hosted link via email (styled with SendGrid)
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
             alt="Equine Transport UK"
             style="width:160px; height:auto;" />
      </div>
    `;

    // Customer email
    await sendgrid.send({
      to: booking.email,
      from: "kverhagen@mac.com",
      subject: `Equine Transport UK | Secure Deposit Link | Booking #${bookingID} | ${booking.firstName} ${booking.lastName}`,
      html: `
        ${logo}
        <h2 style="text-align:center; color:#0070f3;">Deposit Payment Request</h2>
        <p>Dear ${booking.firstName} ${booking.lastName},</p>
        <p>Please complete your deposit hold for <b>Booking #${bookingID}</b>.</p>
        <p><b>Lorry:</b> ${booking.resource}<br/>
           <b>From:</b> ${booking.start}<br/>
           <b>To:</b> ${booking.end}</p>
        <p style="font-size:18px; text-align:center;">
          Deposit Required: <b>£${amount / 100}</b>
        </p>
        <div style="text-align:center; margin:30px 0;">
          <a href="${link}"
             style="padding:14px 22px; background:#0070f3; color:#fff; border-radius:6px; text-decoration:none; font-size:16px;">
            💳 Pay Deposit Securely
          </a>
        </div>
        <p>Kind regards,<br/>Koos & Avril<br/><b>Equine Transport UK</b></p>
      `,
    });

    // Admin email
    await sendgrid.send({
      to: "kverhagen@mac.com",
      from: "kverhagen@mac.com",
      subject: `Admin Copy | Deposit Link Sent | Booking #${bookingID} | ${booking.firstName} ${booking.lastName}`,
      html: `
        ${logo}
        <h3>Deposit link sent to customer</h3>
        <p><b>Booking #${bookingID}</b> (${booking.firstName} ${booking.lastName})</p>
        <p><b>Lorry:</b> ${booking.resource}<br/>
           <b>From:</b> ${booking.start}<br/>
           <b>To:</b> ${booking.end}</p>
        <p><b>Deposit:</b> £${amount / 100}</p>
        <p><b>Customer Email:</b> ${booking.email}</p>
        <p><a href="${link}">💳 Customer Payment Link</a></p>
      `,
    });

    res.json({ success: true, url: link, locationId });
  } catch (err) {
    console.error("❌ SendGrid email error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 5. List ALL active deposits
app.get("/terminal/list-all", async (req, res) => {
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

// ✅ 6. Cancel deposit
app.post("/terminal/cancel", async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    const canceledIntent = await stripe.paymentIntents.cancel(payment_intent_id);
    res.json({ id: canceledIntent.id, status: canceledIntent.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 7. Capture deposit
app.post("/terminal/capture", async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    const capturedIntent = await stripe.paymentIntents.capture(payment_intent_id);
    res.json(capturedIntent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 8. List deposits for a single booking
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

// ✅ Send deposit confirmation email (styled)
app.post("/email/deposit-confirmation", async (req, res) => {
  try {
    const { bookingID, amount } = req.body;
    const booking = await fetchPlanyoBooking(bookingID);

    if (!booking.email) {
      return res.status(400).json({ error: "Could not find customer email" });
    }

    await sendgrid.send({
      to: [booking.email, "kverhagen@mac.com"],
      from: "kverhagen@mac.com",
      subject: `Equine Transport UK | Deposit Hold Confirmation #${bookingID} | ${booking.firstName} ${booking.lastName}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333;">
          <div style="text-align:center; margin-bottom:20px;">
            <img src="https://static.wixstatic.com/media/a9ff84_dfc6008558f94e88a3be92ae9c70201b~mv2.webp"
                 alt="Equine Transport UK"
                 style="width:160px; height:auto;" />
          </div>
          <h2 style="text-align:center; color:#0070f3;">Deposit Hold Confirmation</h2>
          <p><b>⚠️ Note:</b> This is a pre-authorisation only. No money has been taken from your account.</p>
          <p>Dear ${booking.firstName} ${booking.lastName},</p>
          <p>We have successfully placed a <b>deposit hold</b> of <b>£${(amount/100).toFixed(2)}</b> for your booking <b>#${bookingID}</b>.</p>
          <h3>Booking Details</h3>
          <ul>
            <li><b>Lorry:</b> ${booking.resource}</li>
            <li><b>From:</b> ${booking.start}</li>
            <li><b>To:</b> ${booking.end}</li>
            <li><b>Customer:</b> ${booking.firstName} ${booking.lastName}</li>
            <li><b>Email:</b> ${booking.email}</li>
          </ul>
          <h3>About This Deposit</h3>
          <p>The funds remain reserved on your card until we either release the hold (normally within 7 days of return), or capture part/all if required.</p>
          <p>If the vehicle is returned in good condition with full fuel, the deposit will be released in full automatically.</p>
          <p style="margin-top:30px;">With kind regards,<br/>Koos & Avril<br/><b>Equine Transport UK</b></p>
          <hr style="margin:30px 0;"/>
          <p style="font-size:12px; color:#777; text-align:center;">
            Equine Transport UK<br/>
            Upper Broadreed Farm, Stonehurst Lane, Five Ashes, TN20 6LL, East Sussex, GB<br/>
            📞 +44 7584578654 | ✉️ <a href="mailto:kverhagen@mac.com">kverhagen@mac.com</a>
          </p>
        </div>
      `,
    });

    res.json({ success: true, email: booking.email });
  } catch (err) {
    console.error("❌ SendGrid confirmation error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Planyo Callback Handler
app.post("/planyo-callback", (req, res) => {
  const params = req.body;
  const receivedHash = params.hash;
  delete params.hash;

  const sortedKeys = Object.keys(params).sort();
  let concat = "";
  for (const key of sortedKeys) concat += params[key];
  concat += process.env.PLANYO_HASH_KEY;

  const computedHash = crypto.createHash("md5").update(concat).digest("hex");

  if (computedHash === receivedHash) {
    console.log("✅ Verified Planyo callback:", params);
    res.send("OK");
  } else {
    console.warn("❌ Invalid Planyo hash!");
    res.status(400).send("Invalid hash");
  }
});

// ✅ Simple SendGrid test route
app.get("/test/email", async (req, res) => {
  try {
    await sendgrid.send({
      to: "kverhagen@mac.com",
      from: "kverhagen@mac.com",
      subject: "Test Email from Render Backend",
      text: "This is a test email sent from your rental-backend service on Render.",
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ SendGrid test error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
