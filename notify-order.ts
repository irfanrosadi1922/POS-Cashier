// Mengirim notifikasi pesanan online ke APK lewat Firebase Cloud Messaging.
// Secrets yang dibutuhkan: FCM_SERVICE_ACCOUNT (isi JSON kunci akun layanan Firebase), PUSH_KEY.
const b64u = (b: ArrayBuffer | string) => {
  const u = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = ''; u.forEach((c) => (s += String.fromCharCode(c)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
async function accessToken(sa: any) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const pem = String(sa.private_key).replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + claim));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + b64u(sig) }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('token Google gagal: ' + JSON.stringify(j));
  return j.access_token as string;
}
Deno.serve(async (req) => {
  if (req.headers.get('x-push-key') !== Deno.env.get('PUSH_KEY')) return new Response('forbidden', { status: 403 });
  try {
    const { tokens, title, body } = await req.json();
    const sa = JSON.parse(Deno.env.get('FCM_SERVICE_ACCOUNT') || '{}');
    const at = await accessToken(sa);
    const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
    const out = await Promise.all((tokens || []).slice(0, 200).map(async (t: string) => {
      const r = await fetch(url, {
        method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token: t, notification: { title, body },
          android: { priority: 'HIGH', notification: { sound: 'default', channel_id: 'orders' } } } }),
      });
      return r.status;
    }));
    return new Response(JSON.stringify({ sent: out }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
});
