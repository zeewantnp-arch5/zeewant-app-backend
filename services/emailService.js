import nodemailer from "nodemailer";

function getTransportCandidates() {
  const host     = process.env.SMTP_HOST     || "smtp.gmail.com";
  const port     = Number(process.env.SMTP_PORT || 587);
  const user     = process.env.SMTP_USERNAME  || process.env.MAIL_USER;
  const pass     = process.env.SMTP_PASSWORD  || process.env.MAIL_PASS;

  if (!user || !pass)
    throw new Error("Email not configured. Set SMTP_USERNAME and SMTP_PASSWORD in environment variables.");

  const candidates = [{ host, port, user, pass }];

  // On some hosts (including PaaS environments), one Gmail SMTP port can be
  // blocked while the other is reachable. Try the alternate port automatically.
  if (host === "smtp.gmail.com" && port === 587) {
    candidates.push({ host, port: 465, user, pass });
  } else if (host === "smtp.gmail.com" && port === 465) {
    candidates.push({ host, port: 587, user, pass });
  }

  return {
    candidates,
    from: process.env.SMTP_FROM_ADDRESS || user,
  };
}

function createTransporter(host, port, user, pass) {
  return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
      greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
      socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 15000),
    });
}

async function sendWithFallback(mailOptions) {
  const { candidates, from } = getTransportCandidates();
  let lastError;

  for (const candidate of candidates) {
    const { host, port, user, pass } = candidate;
    const transporter = createTransporter(host, port, user, pass);
    try {
      await transporter.sendMail({ ...mailOptions, from: mailOptions.from || `"Zeewant" <${from}>` });
      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `[Email] send failed via ${host}:${port} (${error.code ?? "ERR"}) ${error.message}`
      );
    }
  }

  throw lastError ?? new Error("Failed to send email");
}

export async function sendFollowUpOtpEmail(toEmail, code, durationMinutes) {
  await sendWithFallback({
    from: `"Zeewant" <${process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USERNAME || process.env.MAIL_USER}>`,
    to: toEmail,
    subject: "Zeewant — Follow-Up Session Access Code",
    text: `Your follow-up access code is: ${code}\n\nThis code expires in 10 minutes.\nYour follow-up session duration: ${durationMinutes} minutes.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#f9fafb;border-radius:12px;">
        <div style="text-align:center;margin-bottom:24px;">
          <div style="display:inline-block;background:#008080;border-radius:12px;padding:12px 16px;">
            <span style="color:#fff;font-size:22px;font-weight:bold;letter-spacing:2px;">Zeewant</span>
          </div>
        </div>
        <div style="background:#fff;border-radius:10px;padding:28px 24px;box-shadow:0 1px 4px rgba(0,0,0,.06);">
          <h2 style="margin:0 0 8px;color:#1a1a1a;font-size:18px;">Follow-Up Session Access Code</h2>
          <p style="color:#666;font-size:14px;margin:0 0 24px;">
            Use the code below to unlock your follow-up session.
            Your follow-up duration will be <strong>${durationMinutes} minutes</strong>.
          </p>
          <div style="text-align:center;background:#f0faf9;border:2px dashed #008080;border-radius:10px;padding:20px 0;margin-bottom:24px;">
            <span style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#008080;">${code}</span>
          </div>
          <p style="color:#999;font-size:12px;margin:0;">
            ⏱ This code expires in <strong>10 minutes</strong>.<br/>
            Do not share this code with anyone.
          </p>
        </div>
        <p style="text-align:center;color:#ccc;font-size:11px;margin-top:20px;">
          Zeewant © 2025 · Do not reply to this email
        </p>
      </div>
    `,
  });
}

export async function sendResetCodeEmail(toEmail, code) {
  await sendWithFallback({
    from: `"Zeewant Admin" <${process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USERNAME || process.env.MAIL_USER}>`,
    to: toEmail,
    subject: "Zeewant Admin Panel — Password Reset Code",
    text: `Your password reset code is: ${code}\n\nThis code expires in 15 minutes. Do not share it with anyone.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#f9fafb;border-radius:12px;">
        <div style="text-align:center;margin-bottom:24px;">
          <div style="display:inline-block;background:#00897B;border-radius:12px;padding:12px 16px;">
            <span style="color:#fff;font-size:22px;font-weight:bold;letter-spacing:2px;">Zeewant</span>
          </div>
          <p style="color:#666;font-size:13px;margin-top:6px;letter-spacing:2px;">ADMIN PANEL</p>
        </div>

        <div style="background:#fff;border-radius:10px;padding:28px 24px;box-shadow:0 1px 4px rgba(0,0,0,.06);">
          <h2 style="margin:0 0 8px;color:#1a1a1a;font-size:18px;">Password Reset Request</h2>
          <p style="color:#666;font-size:14px;margin:0 0 24px;">
            We received a request to reset the password for <strong>${toEmail}</strong>.
            Use the code below to set a new password.
          </p>

          <div style="text-align:center;background:#f0faf9;border:2px dashed #00897B;border-radius:10px;padding:20px 0;margin-bottom:24px;">
            <span style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#00897B;">${code}</span>
          </div>

          <p style="color:#999;font-size:12px;margin:0;">
            ⏱ This code expires in <strong>15 minutes</strong>.<br/>
            If you did not request a password reset, you can safely ignore this email.
          </p>
        </div>

        <p style="text-align:center;color:#ccc;font-size:11px;margin-top:20px;">
          Zeewant © 2025 · Admin Panel · Do not reply to this email
        </p>
      </div>
    `,
  });
}
