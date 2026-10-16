const crypto = require('node:crypto');

// Sends `body` as JSON tagged with a fingerprint of its content, or 304 with no
// body when the client already holds exactly this answer (If-None-Match).
//
// The app polls its progress, watchlist, favorites and show states every 20
// seconds, and the progress alone is every watched episode with its date, about
// a megabyte for a big library, almost always unchanged. Express tags JSON
// itself but still answered 200, so every poll downloaded and decoded it all.
//
// Clients that send no fingerprint (older app versions) get the full answer.
// Cloudflare weakens a strong tag when it compresses the response (W/"..."),
// so the comparison ignores that prefix.
function sendJsonWithEtag(request, response, body) {
  const json = JSON.stringify(body);
  const tag = `"${crypto.createHash('sha1').update(json).digest('base64url')}"`;
  response.set('ETag', tag);
  // Per user, and to be checked with the server every time.
  response.set('Cache-Control', 'private, no-cache');
  const held = String(request.get('If-None-Match') || '')
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''));
  if (held.includes(tag)) return response.status(304).end();
  return response.type('application/json').send(json);
}

module.exports = { sendJsonWithEtag };
