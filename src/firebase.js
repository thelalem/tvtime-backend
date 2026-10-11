const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccountConfig =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  let serviceAccount = null;
  if (serviceAccountConfig) {
    const rawValue = serviceAccountConfig.trim();
    const json = rawValue.startsWith('{')
      ? rawValue
      : Buffer.from(rawValue, 'base64').toString('utf8');
    try {
      serviceAccount = JSON.parse(json);
    } catch {
      throw new Error(
        'Firebase service account configuration is invalid. Set FIREBASE_SERVICE_ACCOUNT_JSON to the raw service-account JSON, or FIREBASE_SERVICE_ACCOUNT_BASE64 to its Base64 encoding.',
      );
    }
    if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
      throw new Error(
        'Firebase service account JSON must include project_id, client_email, and private_key.',
      );
    }
  }
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
