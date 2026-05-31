const axios = require('axios');

// In dev, fall back to console logging when Resend rejects the recipient
// (onboarding@resend.dev can only deliver to the Resend account owner's email).
// Set RESEND_FROM to a verified-domain address (e.g. no-reply@yourdomain.com)
// before going to production.
const FROM = process.env.RESEND_FROM || 'Foresight <onboarding@resend.dev>';

async function sendOtpEmail(toEmail, code, purpose) {
  const subject = purpose === 'reset'
    ? 'Reset your Foresight password'
    : 'Your Foresight verification code';

  try {
    const resp = await axios.post(
      'https://api.resend.com/emails',
      {
        from: FROM,
        to: [toEmail],
        subject,
        html: buildHtml(code, purpose),
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 12000,
      }
    );
    return resp.data;
  } catch (err) {
    const resendError = err.response?.data;
    if (
      process.env.NODE_ENV !== 'production' &&
      resendError?.statusCode === 403 &&
      resendError?.name === 'validation_error'
    ) {
      console.warn(`[DEV] Resend blocked delivery to unverified domain. Check your DB otp_codes table for the code (never log codes in production).`);
      return { devFallback: true };
    }
    throw err;
  }
}

function buildHtml(code, purpose) {
  const actionText = purpose === 'reset'
    ? 'reset your password'
    : 'verify your email address';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#000000;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:48px 20px">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0"
        style="background:#0A0A0A;border:1px solid #1A1A1A;border-radius:16px;overflow:hidden;max-width:100%">

        <tr><td style="padding:28px 36px 24px;border-bottom:1px solid #1A1A1A">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="background:#6366F1;border-radius:9px;width:34px;height:34px;text-align:center;vertical-align:middle;font-size:17px">
              🔍
            </td>
            <td style="padding-left:11px;font-size:15px;font-weight:700;color:#F1F5F9;letter-spacing:-0.3px">
              Foresight
            </td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:36px 36px 28px">
          <p style="margin:0 0 6px;font-size:22px;font-weight:800;color:#F1F5F9;letter-spacing:-0.5px">
            Your verification code
          </p>
          <p style="margin:0 0 30px;font-size:14px;color:#94A3B8;line-height:1.65">
            Use the code below to ${actionText}. It expires in <strong style="color:#F1F5F9">10&nbsp;minutes</strong>.
          </p>

          <div style="background:#000000;border:1px solid #222222;border-radius:12px;padding:30px 20px;text-align:center;margin-bottom:28px">
            <span style="font-size:46px;font-weight:800;letter-spacing:14px;color:#6366F1;font-family:'Courier New',Courier,monospace">
              ${code}
            </span>
          </div>

          <p style="margin:0;font-size:12.5px;color:#4B5563;line-height:1.6">
            If you did not request this, you can safely ignore this email.
            Do not share this code with anyone.
          </p>
        </td></tr>

        <tr><td style="padding:18px 36px;border-top:1px solid #1A1A1A">
          <p style="margin:0;font-size:11.5px;color:#374151">
            Foresight: Competitor Intelligence Platform
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Phase 10 — account-deletion confirmation with a cancellation link. The user
// can click the link within the 30-day grace period to restore their account.
async function sendAccountDeletionEmail(toEmail, cancelUrl, scheduledDate) {
  const when = scheduledDate instanceof Date
    ? scheduledDate.toISOString().slice(0, 10)
    : String(scheduledDate || '').slice(0, 10);
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000;padding:48px 20px"><tr><td align="center">
    <table width="480" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #1A1A1A;border-radius:16px;overflow:hidden;max-width:100%">
      <tr><td style="padding:36px 36px 28px">
        <p style="margin:0 0 6px;font-size:21px;font-weight:800;color:#F1F5F9;letter-spacing:-0.5px">We received your deletion request</p>
        <p style="margin:0 0 22px;font-size:14px;color:#94A3B8;line-height:1.65">
          Your Foresight account and all associated data are scheduled to be permanently deleted on
          <strong style="color:#F1F5F9">${when}</strong> (30 days from now).
        </p>
        <p style="margin:0 0 24px;font-size:14px;color:#94A3B8;line-height:1.65">
          If you did not request this, or you changed your mind, click below to cancel and keep your account.
        </p>
        <a href="${cancelUrl}" style="display:inline-block;background:#6366F1;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 22px;border-radius:10px">Cancel deletion &amp; keep my account</a>
        <p style="margin:24px 0 0;font-size:12px;color:#4B5563;line-height:1.6">If the button doesn't work, paste this link into your browser:<br>${cancelUrl}</p>
      </td></tr>
      <tr><td style="padding:18px 36px;border-top:1px solid #1A1A1A"><p style="margin:0;font-size:11.5px;color:#374151">Foresight: Competitor Intelligence Platform</p></td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  try {
    const resp = await axios.post('https://api.resend.com/emails',
      { from: FROM, to: [toEmail], subject: 'Your Foresight account deletion request', html },
      { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 12000 });
    return resp.data;
  } catch (err) {
    const resendError = err.response?.data;
    if (process.env.NODE_ENV !== 'production' && resendError?.statusCode === 403 && resendError?.name === 'validation_error') {
      console.warn(`[DEV] Resend blocked deletion email to unverified domain. Cancellation link: ${cancelUrl}`);
      return { devFallback: true };
    }
    throw err;
  }
}

module.exports = { sendOtpEmail, sendAccountDeletionEmail };
