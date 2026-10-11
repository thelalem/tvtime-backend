const { config } = require('./config');

async function searchTv(query) {
  if (!config.tmdbAccessToken) {
    const error = new Error('TV metadata provider is not configured');
    error.status = 503;
    throw error;
  }

  const url = new URL(`${config.tmdbBaseUrl.replace(/\/$/, '')}/search/tv`);
  url.searchParams.set('query', query);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.tmdbAccessToken}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (cause) {
    const error = new Error(cause.name === 'TimeoutError'
      ? 'TV metadata provider timed out'
      : 'TV metadata provider is unavailable');
    error.status = cause.name === 'TimeoutError' ? 504 : 502;
    throw error;
  }

  if (!response.ok) {
    const error = new Error('TV metadata provider request failed');
    error.status = 502;
    throw error;
  }

  return response.json();
}

module.exports = { searchTv };
