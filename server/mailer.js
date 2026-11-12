// Sends sign-in emails. Production uses the Resend HTTP API (no dependencies: plain fetch).
// Without RESEND_API_KEY the mailer just logs the message, which is only allowed outside production.
export function createMailer(env = process.env) {
  const key = env.RESEND_API_KEY;
  const from = env.MAIL_FROM || 'MellowDo <onboarding@resend.dev>';
  if (!key) {
    return { live: false, async send({ to, subject, text }) { console.log(`[mail to ${to}] ${subject}\n${text}`); } };
  }
  return {
    live: true,
    async send({ to, subject, text }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!res.ok) throw new Error(`Email provider error ${res.status}`);
    },
  };
}
