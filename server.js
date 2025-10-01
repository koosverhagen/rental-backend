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
      req.body,
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
          await sendgrid.send({
            to: [booking.email, "info@equinetransportuk.com"],
            from: { email: "info@equinetransportuk.com", name: "Equine Transport UK" },
            subject: `Equine Transport UK | Deposit Hold Canceled | Booking #${pi.metadata.bookingID}`,
            html: `
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
            `
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
          await sendgrid.send({
            to: [booking.email, "info@equinetransportuk.com"],
            from: { email: "info@equinetransportuk.com", name: "Equine Transport UK" },
            subject: `Equine Transport UK | Deposit Refunded | Booking #${pi.metadata.bookingID}`,
            html: `
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
            `
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
// ✅ 3) Hosted deposit page (Stripe Elements)
// ---------------------------------------------
app.get("/deposit/pay/:bookingID", async (req, res) => {
  const bookingID = req.params.bookingID;
  const amount = 100;

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
<html lang="en"> … (HTML unchanged) … </html>`);
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

    const htmlBody = `<div> … styled HTML … </div>`;

    await sendgrid.send({
      to: booking.email,
      from: { email: "info@equinetransportuk.com", name: "Equine Transport UK" },
      subject: `Equine Transport UK | Secure Deposit Link | Booking #${bookingID} | ${booking.firstName} ${booking.lastName}`,
      html: htmlBody,
    });

    await sendgrid.send({
      to: "info@equinetransportuk.com",
      from: { email: "info@equinetransportuk.com", name: "Equine Transport UK" },
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
// ✅ 9) Deposit confirmation email
// ---------------------------------------------
app.post("/email/deposit-confirmation", async (req, res) => {
  try {
    const { bookingID, amount } = req.body;
    const booking = await fetchPlanyoBooking(bookingID);

    if (!booking.email) {
      return res.status(400).json({ error: "Could not find customer email" });
    }

    const htmlBody = `<div> … styled HTML … </div>`;

    await sendgrid.send({
      to: [booking.email, "info@equinetransportuk.com"],
      from: { email: "info@equinetransportuk.com", name: "Equine Transport UK" },
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
