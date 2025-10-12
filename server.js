// ✅ server.js — corrected for template literal consistency

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const crypto = require("crypto");
const sendgrid = require("@sendgrid/mail");
const cron = require("node-cron");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
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

    const url = `https://www.planyo.com/rest/?method=${method}&api_key=${process.env.PLANYO_API_KEY}&reservation_id=${bookingID}&hash_timestamp=${timestamp}&hash_key=${hashKey}`;
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
  return { resource: "N/A", start: "N/A", end: "N/A", firstName: "", lastName: "", email: null };
}

// ---------------------------------------------
// ✅ Stripe Webhook
// ---------------------------------------------
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`❌ Webhook verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const pi = event.data.object;

  switch (event.type) {
    case "payment_intent.succeeded":
      console.log(`✅ PaymentIntent succeeded: ${pi.id}`);
      break;

    case "payment_intent.payment_failed":
      console.log(`❌ PaymentIntent failed: ${pi.id}`);
      break;

    case "payment_intent.canceled":
      console.log(`⚠️ PaymentIntent canceled: ${pi.id}`);
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
            </div>`;

          await sendgrid.send({
            to: booking.email,
            from: "Equine Transport UK <info@equinetransportuk.com>",
            subject: `Equine Transport UK | Deposit Hold Canceled | Booking #${pi.metadata.bookingID}`,
            html: htmlBody,
          });

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
      console.log(`✅ Charge succeeded: ${pi.id}`);
      break;

    case "charge.refunded":
      console.log(`💸 Charge refunded: ${pi.id}`);
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
              <p>Your deposit for <b>Booking #${pi.metadata.bookingID}</b> has been refunded.</p>
            </div>`;

          await sendgrid.send({
            to: booking.email,
            from: "Equine Transport UK <info@equinetransportuk.com>",
            subject: `Equine Transport UK | Deposit Refunded | Booking #${pi.metadata.bookingID}`,
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

app.use(cors());
app.use(express.json());

// ---------------------------------------------
// ✅ Create PaymentIntent (manual capture HOLD)
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
// ✅ Hosted deposit page
// ---------------------------------------------
app.get("/deposit/pay/:bookingID", async (req, res) => {
  const bookingID = req.params.bookingID;
  const amount = 100; // £1 for testing
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
<html>
<head>
<meta charset="UTF-8" />
<title>Deposit Hold - Booking ${bookingID}</title>
<script src="https://js.stripe.com/v3/"></script>
</head>
<body>
  <h2>Deposit Hold (£${(amount / 100).toFixed(2)})</h2>
  <p>${booking.firstName} ${booking.lastName} – ${booking.resource}<br>${booking.start} → ${booking.end}</p>
  <form id="payment-form">
    <div id="card-element"></div>
    <button id="submit">Confirm Hold</button>
    <div id="result"></div>
  </form>
  <script>
    const stripe = Stripe("${process.env.STRIPE_PUBLISHABLE_KEY}");
    const clientSecret = "${intent.client_secret}";
    const elements = stripe.elements();
    const card = elements.create("card");
    card.mount("#card-element");
    const form = document.getElementById("payment-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const {error, paymentIntent} = await stripe.confirmCardPayment(clientSecret, {
        payment_method: {card}
      });
      const resultDiv = document.getElementById("result");
      if (error) resultDiv.textContent = "❌ " + error.message;
      else if (paymentIntent.status === "requires_capture") {
        resultDiv.textContent = "✅ Hold Successful. Redirecting…";
        fetch(\`${process.env.SERVER_URL}/email/deposit-confirmation\`, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({ bookingID: "${bookingID}", amount: ${amount} })
        });
        setTimeout(() => {
          window.location.href = \`https://www.equinetransportuk.com/thank-you?bookingID=${bookingID}&amount=${amount}\`;
        }, 2000);
      }
    });
  </script>
</body>
</html>`);
});

// ---------------------------------------------
// ✅ Deposit link via email
// ---------------------------------------------
app.post("/deposit/send-link", async (req, res) => {
  try {
    const { bookingID, amount } = req.body;
    const booking = await fetchPlanyoBooking(bookingID);
    if (!booking.email) return res.status(400).json({ error: "No email" });

    const link = `${process.env.SERVER_URL}/deposit/pay/${bookingID}`;
    const htmlBody = `
      <h2>Deposit Payment Request</h2>
      <p>Dear ${booking.firstName} ${booking.lastName}, please complete deposit for <b>Booking #${bookingID}</b>.</p>
      <a href="${link}" style="background:#0070f3;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;">Pay Securely</a>
      <p>Amount: £${(amount / 100).toFixed(2)}</p>`;

    await sendgrid.send({
      to: booking.email,
      from: "Equine Transport UK <info@equinetransportuk.com>",
      subject: `Equine Transport UK | Secure Deposit Link | Booking #${bookingID}`,
      html: htmlBody,
    });

    res.json({ success: true, url: link });
  } catch (err) {
    console.error("❌ SendGrid email error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------
// 🧠 Scheduler core
// ---------------------------------------------
async function planyoCall(method, params = {}) {
  const buildUrl = (timestamp) => {
    const raw = process.env.PLANYO_HASH_KEY + timestamp + method;
    const hashKey = crypto.createHash("md5").update(raw).digest("hex");
    const query = new URLSearchParams({
      method,
      api_key: process.env.PLANYO_API_KEY,
      site_id: process.env.PLANYO_SITE_ID,
      hash_timestamp: timestamp,
      hash_key: hashKey,
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    });
    return `https://www.planyo.com/rest/?${query.toString()}`;
  };

  const timestamp = Math.floor(Date.now() / 1000);
  const url = buildUrl(timestamp);
  console.log(`🧠 Using hash_timestamp: ${timestamp}`);
  const resp = await fetch(url);
  const json = await resp.json();
  return { url, json, timestamp };
}

// // ---------------------------------------------
// 🧠 Scheduler core function — stable version using list_reservations
// ---------------------------------------------
async function runDepositScheduler(mode) {
    try {
        const method = "list_reservations";
        const resourceIDs = [
            "239201", "234303", "234304", "234305", "234306"
        ];
        
        // 🗓 Date logic remains correct 🗓
        const today = new Date();
        const tomorrow = new Date(today.getTime() + (24 * 60 * 60 * 1000));
        
        const from_day = tomorrow.getDate();
        const from_month = tomorrow.getMonth() + 1;
        const from_year = tomorrow.getFullYear();
        
        let allBookings = [];
        console.log(`📅 Searching bookings for tomorrow (${from_day}/${from_month}/${from_year}) [All Day] across ${resourceIDs.length} resources.`);

        // 🔄 Loop through each resource ID and make a separate API call
        for (const resourceID of resourceIDs) {
            
            // ✅ Core parameters - RE-ADDED start_time, end_time, and resource_id
            const params = {
                from_day,
                from_month,
                from_year,
                to_day: from_day,
                to_month: from_month,
                to_year: from_year,
                start_time: 0,    // 00:00 - MUST BE INCLUDED
                end_time: 24,     // 24:00 - MUST BE INCLUDED
                req_status: 4,    // confirmed bookings
                include_unconfirmed: 1,
                resource_id: resourceID, // MUST BE INCLUDED
                // calendar: process.env.PLANYO_SITE_ID, <-- Still removed for redundancy
            };

            // ✅ Call Planyo
            const { url, json: data } = await planyoCall(method, params);
            
            if (data?.response_code === 0 && data.data?.results?.length > 0) {
                console.log(`✅ Found ${data.data.results.length} booking(s) for resource ${resourceID}`);
                allBookings.push(...data.data.results);
            }
        }
        
        // ----------------------------------------
        // Process Final List of Bookings
        // ----------------------------------------

        if (allBookings.length > 0) {
            // ... (success logic) ...
        } else {
            console.log(`ℹ️ No bookings found for tomorrow in ${mode} run across all specified resources.`);
        }
    } catch (err) {
        console.error("❌ Deposit scheduler error:", err);
    }
}
cron.schedule("0 18 * * *", async () => {
  console.log("🕕 Auto scheduler triggered...");
  await runDepositScheduler("auto");
});

(async () => {
  console.log("⚡ Manual test run...");
  await runDepositScheduler("manual");
})();

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
