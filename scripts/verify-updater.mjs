import {createHash, createPublicKey, verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Release-side check of Tauri's base64-wrapped Minisign format. Crypto is
// provided by Node/OpenSSL; the application still verifies via its updater.
export function verifyUpdaterSignature(data, encodedKey, encodedSignature) {
  const decode = value => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid base64');
    return Buffer.from(value, 'base64');
  };
  const keyLines = decode(encodedKey.trim()).toString('utf8').trimEnd().split(/\r?\n/);
  const lines = decode(encodedSignature.trim()).toString('utf8').trimEnd().split(/\r?\n/);
  if (keyLines.length !== 2 || lines.length !== 4 || !lines[2].startsWith('trusted comment: ')) throw new Error('Invalid Minisign envelope');
  const key = decode(keyLines[1]), packet = decode(lines[1]), globalSignature = decode(lines[3]);
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed' || packet.length !== 74 || globalSignature.length !== 64) throw new Error('Invalid Minisign packet');
  if (!key.subarray(2, 10).equals(packet.subarray(2, 10))) throw new Error('Signing key does not match app updater public key');
  const algorithm = packet.subarray(0, 2).toString();
  if (algorithm !== 'ED') throw new Error('Expected prehashed Minisign signature');
  const publicKey = createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki'});
  const signature = packet.subarray(10);
  if (!verify(null, createHash('blake2b512').update(data).digest(), publicKey, signature)) throw new Error('Installer signature verification failed');
  if (!verify(null, Buffer.concat([signature, Buffer.from(lines[2].slice(17))]), publicKey, globalSignature)) throw new Error('Signed metadata verification failed');
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const installer = process.argv[2];
  if (!installer) throw new Error('Usage: node scripts/verify-updater.mjs <installer.exe>');
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  verifyUpdaterSignature(readFileSync(installer), config.plugins.updater.pubkey, readFileSync(`${installer}.sig`, 'utf8'));
  console.log('Updater signature verified against the public key embedded in the app.');
}
