// The gateway's own TLS certificate: self-signed, made here with Node's crypto (no openssl on the server), and pinned
// by the Mac at pairing (ux-rules F2). Being self-signed is fine because trust never comes from a CA: it comes from the
// code `serra server pair` prints and the three words its fingerprint gives (F5), or from the SSH channel.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';

// A minimal DER writer: just the shapes an X.509 v3 certificate needs.
const length = (size: number): Buffer => {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), length(body.length), body]);
const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const integer = (bytes: Buffer): Buffer => tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const oid = (dotted: string): Buffer => {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const out = [first! * 40 + second!];
  for (const part of rest) {
    const chunk: number[] = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'));
const bitString = (bytes: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), bytes]));
const octetString = (bytes: Buffer): Buffer => tlv(0x04, bytes);
// RFC 5280: UTCTime through 2049, GeneralizedTime after.
const time = (date: Date): Buffer => {
  const digits = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii')) : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'));
};
const explicit = (tag: number, body: Buffer): Buffer => tlv(0xa0 | tag, body);

const ECDSA_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));

/** A certificate and its private key, both PEM. */
export interface GatewayCert { cert: string; key: string }

/**
 * A new P-256 key and a self-signed certificate for it, valid `days` from `now`. The subject is `name`; the
 * certificate also names `localhost`, so a tunnel can reach it, but the Mac checks the fingerprint, not the name.
 */
export const selfSignedCert = (name: string, { now = new Date(), days = 3650 }: { now?: Date; days?: number } = {}): GatewayCert => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const subject = sequence(set(sequence(oid('2.5.4.3'), utf8(name.slice(0, 64) || 'Serra'))));
  const notAfter = new Date(now.getTime() + days * 86_400_000);
  const serial = randomBytes(16);
  // Positive, and never a leading zero byte: DER wants the shortest form, and one certificate in 128 broke without it.
  serial[0] = (serial[0]! & 0x7f) | 0x40;
  const dnsName = (host: string): Buffer => tlv(0x82, Buffer.from(host, 'ascii'));
  const extensions = explicit(3, sequence(
    // Basic constraints: its own trust anchor and nothing below it (CA, path length 0), so the pinned certificate
    // verifies as the one root in OpenSSL and in Electron's BoringSSL alike. It signs no other certificate.
    sequence(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), octetString(sequence(tlv(0x01, Buffer.from([0xff])), integer(Buffer.from([0]))))),
    // Key usage, critical: digital signature (TLS) and certificate signing (itself).
    sequence(oid('2.5.29.15'), tlv(0x01, Buffer.from([0xff])), octetString(tlv(0x03, Buffer.from([0x02, 0x84])))),
    // Extended key usage: TLS server.
    sequence(oid('2.5.29.37'), octetString(sequence(oid('1.3.6.1.5.5.7.3.1')))),
    // Subject alternative names.
    sequence(oid('2.5.29.17'), octetString(sequence(dnsName('localhost'), tlv(0x87, Buffer.from([127, 0, 0, 1]))))),
  ));
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_SHA256,
    subject,
    sequence(time(now), time(notAfter)),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(tbs, ECDSA_SHA256, bitString(signature));
  const body = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
    key: String(privateKey.export({ type: 'pkcs8', format: 'pem' })),
  };
};

/** `sha256:` and the certificate's SHA-256 in lowercase hex, without colons. Throws for text that isn't a certificate. */
export const certFingerprint = (cert: string | Buffer): string =>
  `sha256:${new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase()}`;

/** The certificate as PEM, from the DER bytes a TLS socket reports. */
export const pemFromDer = (der: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

/** True when `key` is the private key for `cert`. */
export const certMatchesKey = (cert: string, key: string): boolean => {
  try { return new X509Certificate(cert).checkPrivateKey(createPrivateKey(key)); } catch { return false; }
};
