// CoachMint — generate a VAPID keypair for Web Push (one-time setup).
//   node scripts/gen-vapid.mjs
// Print the two values and put them in .env / the hosting env vars:
//   VAPID_PUBLIC_KEY=...   (base64url, 65 bytes — starts with "B")
//   VAPID_PRIVATE_KEY=...  (base64url, 32 bytes)
import crypto from 'node:crypto';

const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const pub = ecdh.getPublicKey();      // 65-byte uncompressed point
const prv = ecdh.getPrivateKey();     // 32 bytes

console.log('VAPID_PUBLIC_KEY=' + pub.toString('base64url'));
console.log('VAPID_PRIVATE_KEY=' + prv.toString('base64url'));
