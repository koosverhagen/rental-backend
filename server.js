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

// ✅ Nodemailer SMTP transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
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

// ✅ 2. Create PaymentIntent (manual capture HOLD) – API
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

// ✅ 3. Serve hosted deposit entry page (mobile-first + email trigger + auto-polling)
app.get("/deposit/pay/:bookingID", async (req, res) => {
  const bookingID = req.params.bookingID;
  const amount = 100; // £1 hold

  const booking = await fetchPlanyoBooking(bookingID);

  const intent = await stripe.paymentIntents.create({
    amount,
    currency: "gbp",
    capture_method: "manual", // 👈 HOLD, not charge
    payment_method_types: ["card"],
    metadata: { bookingID },
    description: `Booking #${bookingID} | ${booking.firstName} ${booking.lastName} | ${booking.resource}`,
  });

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0"/>
      <title>Deposit Hold - Booking ${bookingID}</title>
      <script src="https://js.stripe.com/v3/"></script>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin:0; padding:0; background:#f8f9fa; }
        .container { width:95%; max-width:500px; margin:0 auto; padding:20px; }
        h2 { font-size:24px; margin-bottom:10px; text-align:center; }
        p { font-size:16px; line-height:1.3; text-align:center; margin-bottom:15px; }
        label { display:block; font-size:16px; margin:10px; }
        .StripeElement, input { padding:12px; font-size:18px; border:2px solid #ccc; border-radius:8px; background:#fff; width:100%; margin-bottom:12px; }
        button { width:100%; padding:12px; font-size:18px; background:#0070f3; color:#fff; border:none; border-radius:8px; cursor:pointer; margin-top:10px; }
        #result { margin-top:15px; font-size:16px; text-align:center; }
        .spinner {
          border: 4px solid #f3f3f3;
          border-top: 4px solid #0070f3;
          border-radius: 50%;
          width: 24px;
          height: 24px;
          animation: spin 1s linear infinite;
          display: inline-block;
          margin-right: 8px;
        }
        @keyframes spin { 100% { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>Deposit Hold (£${amount/100})</h2>
        <p>
          Booking <b>#${bookingID}</b><br/>
          ${booking.firstName} ${booking.lastName}<br/>
          ${booking.resource}<br/>
          ${booking.start} → ${booking.end}
        </p>
        
        <form id="payment-form">
          <label>Card Number</label>
          <div id="card-number" class="StripeElement"></div>
          
          <label>Expiry Date</label>
          <div id="card-expiry" class="StripeElement"></div>
          
          <label>CVC</label>
          <div id="card-cvc" class="StripeElement"></div>
          
          <label>Postal Code</label>
          <input id="postal-code" type="text" placeholder="Postcode" />
          
          <button id="submit">Confirm Hold</button>
        </form>
        
        <div id="result"></div>
      </div>

      <script>
        const stripe = Stripe("${process.env.STRIPE_PUBLISHABLE_KEY}");
        const clientSecret = "${intent.client_secret}";
        const elements = stripe.elements({ style: { base: { fontSize: "18px" } } });

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
          const postalCode = document.getElementById("postal-code").value;

          resultDiv.innerHTML = '<div class="spinner"></div>⏳ Waiting for hold to be made...';

          const {error, paymentIntent} = await stripe.confirmCardPayment(clientSecret, {
            payment_method: {
              card: cardNumber,
              billing_details: { address: { postal_code: postalCode } }
            }
          });

          if (error) {
            resultDiv.innerText = "❌ " + error.message;
          } else {
            // ✅ Tell backend to send confirmation email
            fetch("${process.env.SERVER_URL}/email/deposit-confirmation", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ bookingID: "${bookingID}", amount: ${amount} })
            }).catch(() => {});

            // 🔄 Poll backend until it reports "Hold Successful"
            const poll = async () => {
              const res = await fetch("${process.env.SERVER_URL}/terminal/list/${bookingID}");
              const data = await res.json();
              if (data.length > 0 && data[0].status === "Hold Successful") {
                resultDiv.innerHTML = "✅ Hold Successful<br/>📩 Confirmation emails sent.";
              } else {
                setTimeout(poll, 3000);
              }
            };
            poll();
          }
        });
      </script>
    </body>
    </html>
  `);
});

// ✅ 4. Send hosted link via email
app.post("/deposit/send-link", async (req, res) => {
  try {
    const { bookingID, amount } = req.body;
    const booking = await fetchPlanyoBooking(bookingID);

    if (!booking.email) {
      return res.status(400).json({ error: "No customer email found" });
    }

    const link = `${process.env.SERVER_URL}/deposit/pay/${bookingID}`;

    const logo = `
      <div style="text-align:center; margin-bottom:20px;">
        <img src="https://static.wixstatic.com/media/a9ff84_dfc6008558f94e88a3be92ae9c70201b~mv2.webp"
             alt="Equine Transport UK"
             style="width:160px; height:auto;" />
      </div>
    `;

    // Customer email
    await transporter.sendMail({
      from: `"Equine Transport UK" <${process.env.SMTP_USER}>`,
      to: booking.email,
      subject: `Equine Transport UK | Secure Deposit Link | Booking #${bookingID} | ${booking.firstName} ${booking.lastName}`,
      html: `
        ${logo}
        <p>Booking <b>#${bookingID}</b> (${booking.firstName} ${booking.lastName})</p>
        <p><b>Lorry:</b> ${booking.resource}</p>
        <p><b>From:</b> ${booking.start}</p>
        <p><b>To:</b> ${booking.end}</p>
        <p>Deposit: <b>£${amount / 100}</b></p>
        <p><a href="${link}" style="padding:14px 22px; background:#0070f3; color:#fff; border-radius:6px; text-decoration:none; font-size:16px;">💳 Pay Deposit</a></p>
      `,
    });

    // Admin email
    await transporter.sendMail({
      from: `"Equine Transport UK" <${process.env.SMTP_USER}>`,
      to: "kverhagen@mac.com",
      subject: `Admin Copy | Deposit Link for Booking #${bookingID} | ${booking.firstName} ${booking.lastName}`,
      html: `
        ${logo}
        <p>Booking <b>#${bookingID}</b> (${booking.firstName} ${booking.lastName})</p>
        <p><b>Lorry:</b> ${booking.resource}</p>
        <p><b>From:</b> ${booking.start}</p>
        <p><b>To:</b> ${booking.end}</p>
        <p>Deposit: <b>£${amount / 100}</b></p>
        <p><a href="${link}" style="padding:14px 22px; background:#0070f3; color:#fff; border-radius:6px; text-decoration:none; font-size:16px;">💳 Pay Deposit</a></p>
      `,
    });

    res.json({ success: true, url: link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 5. List ALL active deposits (requires_capture → Hold Successful)
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
          status: "Hold Successful", // 👈 renamed here
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

// ✅ 8. List deposits for a single booking (requires_capture → Hold Successful)
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
      status: pi.status === "requires_capture" ? "Hold Successful" : pi.status, // 👈 rename here
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

// ✅ Send deposit confirmation email (after HOLD succeeds)
app.post("/email/deposit-confirmation", async (req, res) => {
  try {
    const { bookingID, amount } = req.body;
    const booking = await fetchPlanyoBooking(bookingID);

    if (!booking.email) {
      return res.status(400).json({ error: "Could not find customer email in Planyo" });
    }

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333;">
        <img src="https://static.wixstatic.com/media/a9ff84_dfc6008558f94e88a3be92ae9c70201b~mv2.webp"
             alt="Equine Transport UK"
             style="width:160px; height:auto; display:block; margin:0 auto 20px auto;" />

        <h2 style="text-align:center; color:#0070f3;">Deposit Hold Confirmation</h2>
        
        <p><b>⚠️ Note:</b> This is a <b>pre-authorisation only</b>. No money has been taken from your account.</p>
        
        <p>Dear ${booking.firstName} ${booking.lastName},</p>
        
        <p>We have successfully placed a <b>deposit HOLD</b> of 
        <b>£${(amount/100).toFixed(2)}</b> for your booking <b>#${bookingID}</b>.</p>

        <h3>Booking Details</h3>
        <ul>
          <li><b>Lorry:</b> ${booking.resource}</li>
          <li><b>From:</b> ${booking.start}</li>
          <li><b>To:</b> ${booking.end}</li>
          <li><b>Customer:</b> ${booking.firstName} ${booking.lastName}</li>
          <li><b>Email:</b> ${booking.email}</li>
        </ul>

        <h3>About This Deposit</h3>
        <p>
          The funds remain reserved on your card until we either:
        </p>
        <ul>
          <li>Release the hold (normally within 7 days of vehicle return), or</li>
          <li>Capture part or all of the deposit if required.</li>
        </ul>

        <p>The deposit covers costs such as:</p>
        <ul>
          <li>Refuelling charges if the vehicle is not returned full</li>
          <li>Damage or excessive wear during the hire</li>
          <li>Other costs per your hire agreement</li>
        </ul>

        <p>If the vehicle is returned in the same condition and with full fuel tanks,  
        the deposit will be released in full automatically.</p>

        <p style="margin-top:30px;">With kind regards,<br/>
        Koos & Avril<br/>
        <b>Equine Transport UK</b></p>

        <hr style="margin:30px 0;" />
        <p style="font-size:12px; color:#777; text-align:center;">
          Equine Transport UK<br/>
          Upper Broadreed Farm, Stonehurst Lane, Five Ashes, TN20 6LL, East Sussex, GB<br/>
          📞 +44 7584578654 | ✉️ <a href="mailto:kverhagen@mac.com">kverhagen@mac.com</a>
        </p>
      </div>
    `;

    await transporter.sendMail({
      from: `"Equine Transport UK" <${process.env.SMTP_USER}>`,
      to: [booking.email, "kverhagen@mac.com"],
      subject: `Equine Transport UK | Deposit Hold Confirmation #${bookingID} | ${booking.firstName} ${booking.lastName}`,
      html: htmlBody,
    });

    res.json({ success: true, email: booking.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
