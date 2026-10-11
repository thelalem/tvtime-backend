const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const credential = serviceAccountBase64
    ? admin.credential.cert(JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8')))
    : admin.credential.applicationDefault();
  admin.initializeApp({
    credential,
  });
}

module.exports = { admin };
