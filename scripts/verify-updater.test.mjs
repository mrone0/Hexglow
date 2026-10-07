import {createHash, generateKeyPairSync, randomBytes, sign} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {verifyUpdaterSignature} from './verify-updater.mjs';

function fixture() {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const id = randomBytes(8), data = Buffer.from('release test');
  const signature = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
  const comment = 'timestamp:123\tfile:Hexglow.exe';
  const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
  const key = Buffer.concat([Buffer.from('Ed'), id, publicKey.export({format:'der',type:'spki'}).subarray(-32)]).toString('base64');
  const packet = Buffer.concat([Buffer.from('ED'), id, signature]).toString('base64');
  const encodedKey = Buffer.from(`untrusted comment: test\n${key}\n`).toString('base64');
  const text = `untrusted comment: test\n${packet}\ntrusted comment: ${comment}\n${globalSignature.toString('base64')}\n`;
  return {data, encodedKey, text, encodedSignature: Buffer.from(text).toString('base64')};
}

describe('release signature verification', () => {
  it('verifies installer content and signed metadata', () => {
    const f = fixture();expect(verifyUpdaterSignature(f.data, f.encodedKey, f.encodedSignature)).toBe(true);
  });
  it('rejects changed installer, signing key, metadata and malformed signatures', () => {
    const f = fixture();
    expect(() => verifyUpdaterSignature(Buffer.from('tampered'), f.encodedKey, f.encodedSignature)).toThrow('Installer signature');
    expect(() => verifyUpdaterSignature(f.data, fixture().encodedKey, f.encodedSignature)).toThrow('Signing key');
    expect(() => verifyUpdaterSignature(f.data, f.encodedKey, Buffer.from(f.text.replace('timestamp:123', 'timestamp:124')).toString('base64'))).toThrow('metadata');
    expect(() => verifyUpdaterSignature(f.data, f.encodedKey, 'invalid!')).toThrow('base64');
  });
});
