// The actor page (FEATURE_PLAN.md section 21): TMDB's person record cut down to what the app shows. TMDB's own answer
// for a busy actor runs to hundreds of KB (every credit with its overview, every photo), and it is cached that way in
// PostgreSQL, so only this slim form is kept.

// Talk shows and news: an actor's guest spots on them are dozens of "Self" rows that bury the actual roles.
const hiddenShowGenres = new Set([10763, 10767]);
const maxPhotos = 20;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// The fields a show or movie needs to open its own page in the app, plus the part played. No overview: it is most of
// the size, and the title's own page loads it.
function titleOf(credit, kind) {
  const base = {
    id: credit.id,
    poster_path: text(credit.poster_path),
    backdrop_path: text(credit.backdrop_path),
    vote_average: number(credit.vote_average),
    vote_count: number(credit.vote_count),
    popularity: number(credit.popularity),
    roles: [],
  };
  if (kind === 'tv') {
    return { ...base, name: text(credit.name) || text(credit.original_name) || '', first_air_date: credit.first_air_date || '', episode_count: 0 };
  }
  return { ...base, title: text(credit.title) || text(credit.original_title) || '', release_date: credit.release_date || '' };
}

// One row per show or movie: TMDB lists a title once per character (and a crew title once per job), so those are
// merged, roles in order and episode counts added up.
function mergeCredits(credits, kind, role, into) {
  for (const credit of credits) {
    if (!credit || credit.media_type !== kind || !Number.isInteger(credit.id) || credit.id <= 0) continue;
    if (kind === 'tv' && Array.isArray(credit.genre_ids) && credit.genre_ids.some((id) => hiddenShowGenres.has(id))) continue;
    let row = into.get(credit.id);
    if (!row) {
      row = titleOf(credit, kind);
      into.set(credit.id, row);
    }
    const name = text(role(credit));
    if (name && !row.roles.includes(name)) row.roles.push(name);
    if (kind === 'tv') row.episode_count += number(credit.episode_count);
  }
}

// TMDB keeps every spelling a role was credited under: "Sharon Raydor, Captain Sharon Raydor, Sharon Raydor
// (archive footage) (uncredited)". The notes go, and a role already inside a longer one goes ("(voice)" stays).
function tidyRoles(roles) {
  const cleaned = [];
  for (const role of roles) {
    const name = role.replace(/\s*\((uncredited|archive footage)\)/gi, '').trim();
    if (name && !cleaned.some((kept) => kept.toLowerCase() === name.toLowerCase())) cleaned.push(name);
  }
  return cleaned.filter((role) => !cleaned.some((other) =>
    other !== role && other.toLowerCase().includes(role.toLowerCase())));
}

function titles(cast, crew, kind, withCrew) {
  const rows = new Map();
  mergeCredits(cast, kind, (credit) => credit.character, rows);
  // A director or writer is listed under their crew jobs; an actor's odd producer credit would only add noise.
  if (withCrew) mergeCredits(crew, kind, (credit) => credit.job, rows);
  return [...rows.values()].map(({ roles, ...row }) => ({ ...row, character: tidyRoles(roles).join(', ') }));
}

function slimPerson(person) {
  const credits = person.combined_credits || {};
  const cast = Array.isArray(credits.cast) ? credits.cast : [];
  const crew = Array.isArray(credits.crew) ? credits.crew : [];
  const department = text(person.known_for_department);
  const withCrew = department !== null && department !== 'Acting';
  const ids = person.external_ids || {};
  const profiles = person.images && Array.isArray(person.images.profiles) ? person.images.profiles : [];
  return {
    id: person.id,
    name: text(person.name) || '',
    biography: text(person.biography) || '',
    birthday: text(person.birthday),
    deathday: text(person.deathday),
    place_of_birth: text(person.place_of_birth),
    known_for_department: department,
    profile_path: text(person.profile_path),
    external_ids: {
      imdb_id: text(ids.imdb_id),
      instagram_id: text(ids.instagram_id),
      twitter_id: text(ids.twitter_id),
      facebook_id: text(ids.facebook_id),
      tiktok_id: text(ids.tiktok_id),
      youtube_id: text(ids.youtube_id),
    },
    photos: profiles.map((image) => text(image && image.file_path)).filter(Boolean).slice(0, maxPhotos),
    shows: titles(cast, crew, 'tv', withCrew),
    movies: titles(cast, crew, 'movie', withCrew),
  };
}

module.exports = { slimPerson };
