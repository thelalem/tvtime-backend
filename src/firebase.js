const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const serviceAccount = serviceAccountBase64
    ? JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'))
    : null;
  const credential = serviceAccount
    ? admin.credential.cert(serviceAccount)
    : admin.credential.applicationDefault();
  admin.initializeApp({
    credential,
    // On hosts such as EthioDeploy, ADC often has no discoverable project ID.
    // An explicit ID also lets Firebase Auth verify tokens without guessing it.
    projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount?.project_id,
  });
}

module.exports = { admin };
