// A small in-memory limiter: at most `limit` calls per `windowMs` for each key (a user id). The backend has no rate
// limiting of its own, and the social routes (search, username checks, follows) let one person probe others, so they
// get this. It is per process, which is enough for one server; a restart forgets the counts.
function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map(); // key -> timestamps (ms) inside the window

  function allow(key) {
    const t = now();
    const recent = (hits.get(key) || []).filter((at) => t - at < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    return true;
  }

  // Drops keys with nothing in the window, so the map does not grow with every user ever seen.
  function sweep() {
    const t = now();
    for (const [key, list] of hits) {
      if (!list.some((at) => t - at < windowMs)) hits.delete(key);
    }
  }

  return { allow, sweep, size: () => hits.size };
}

// Express middleware: answers 429 with `retryAfter` seconds when `request.user.uid` is over the limit.
function limitRoute(limiter, windowMs) {
  return (request, response, next) => {
    if (limiter.allow(request.user.uid)) return next();
    response.set('Retry-After', String(Math.ceil(windowMs / 1000)));
    return response.status(429).json({ error: 'rate_limited', retryAfter: Math.ceil(windowMs / 1000) });
  };
}

module.exports = { createRateLimiter, limitRoute };
