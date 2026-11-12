/**
 * Amazon SNS message verification (https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html):
 * the signing certificate must come from an SNS host over HTTPS, and the RSA signature must match the
 * canonical string built from the message fields.
 */

export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation' | string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
}

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export function isSnsUrl(u: string | undefined): boolean {
  try {
    const url = new URL(u || '');
    return url.protocol === 'https:' && SNS_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/** The exact string SNS signed, per message type. */
export function stringToSign(m: SnsMessage): string {
  const keys =
    m.Type === 'Notification'
      ? ['Message', 'MessageId', ...(m.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.map((k) => `${k}\n${(m as unknown as Record<string, string>)[k] ?? ''}\n`).join('');
}

// ---- minimal DER reader: just enough to pull SubjectPublicKeyInfo out of an X.509 certificate ----

function tlv(b: Uint8Array, off: number) {
  const tag = b[off];
  let len = b[off + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[off + 2 + i];
    hdr += n;
  }
  return { tag, start: off, body: off + hdr, end: off + hdr + len };
}

/** SubjectPublicKeyInfo bytes from a DER X.509 certificate. */
export function spkiFromCert(der: Uint8Array): Uint8Array {
  const cert = tlv(der, 0);
  const tbs = tlv(der, cert.body);
  let p = tbs.body;
  if (der[p] === 0xa0) p = tlv(der, p).end; // [0] version
  for (let i = 0; i < 5; i++) p = tlv(der, p).end; // serial, signature alg, issuer, validity, subject
  const spki = tlv(der, p);
  return der.slice(spki.start, spki.end);
}

export function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

async function signingKey(certUrl: string, hash: 'SHA-1' | 'SHA-256'): Promise<CryptoKey> {
  const cacheKey = `${hash} ${certUrl}`;
  let p = keyCache.get(cacheKey);
  if (!p) {
    p = (async () => {
      const res = await fetch(certUrl);
      if (!res.ok) throw new Error(`Couldn't fetch SNS signing certificate (${res.status})`);
      const spki = spkiFromCert(pemToDer(await res.text()));
      return crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
    })();
    keyCache.set(cacheKey, p);
    p.catch(() => keyCache.delete(cacheKey));
  }
  return p;
}

/** True if the message really comes from Amazon SNS. */
export async function verifySnsMessage(m: SnsMessage): Promise<boolean> {
  if (!m || typeof m !== 'object' || !m.Signature || !m.SigningCertURL) return false;
  if (!isSnsUrl(m.SigningCertURL) || !new URL(m.SigningCertURL).pathname.endsWith('.pem')) return false;
  const hash = m.SignatureVersion === '1' ? 'SHA-1' : m.SignatureVersion === '2' ? 'SHA-256' : null;
  if (!hash) return false;
  try {
    const key = await signingKey(m.SigningCertURL, hash);
    const sig = Uint8Array.from(atob(m.Signature), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(stringToSign(m)));
  } catch (err) {
    console.error('SNS verification failed', (err as Error).message);
    return false;
  }
}
