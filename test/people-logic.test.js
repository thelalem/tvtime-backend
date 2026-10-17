const test = require('node:test');
const assert = require('node:assert/strict');
const { slimPerson } = require('../src/people-logic');

const person = (extra = {}) => ({
  id: 17419,
  name: 'Bryan Cranston',
  biography: ' An actor. ',
  birthday: '1956-03-07',
  deathday: null,
  place_of_birth: 'Hollywood, California, USA',
  known_for_department: 'Acting',
  profile_path: '/p.jpg',
  external_ids: { imdb_id: 'nm0186505', instagram_id: 'bryancranston', twitter_id: '', facebook_id: null },
  images: { profiles: [{ file_path: '/a.jpg' }, { file_path: '' }, { file_path: '/b.jpg' }] },
  combined_credits: {
    cast: [
      { id: 1396, media_type: 'tv', name: 'Breaking Bad', character: 'Walter White', episode_count: 60, genre_ids: [18] },
      { id: 1396, media_type: 'tv', name: 'Breaking Bad', character: 'Heisenberg', episode_count: 2, genre_ids: [18] },
      { id: 22980, media_type: 'tv', name: 'Late Night', character: 'Self', episode_count: 4, genre_ids: [10767] },
      { id: 49026, media_type: 'movie', title: 'The Dark Knight Rises', character: '', release_date: '2012-07-16' },
    ],
    crew: [
      { id: 1396, media_type: 'tv', name: 'Breaking Bad', job: 'Director', episode_count: 3 },
      { id: 777, media_type: 'movie', title: 'Producer only', job: 'Producer' },
    ],
  },
  ...extra,
});

test('one row per title, roles merged, episode counts added, talk shows left out', () => {
  const slim = slimPerson(person());
  assert.equal(slim.biography, 'An actor.');
  assert.deepEqual(slim.shows.map((show) => [show.id, show.character, show.episode_count]), [
    [1396, 'Walter White, Heisenberg', 62],
  ]);
  assert.deepEqual(slim.movies.map((movie) => [movie.id, movie.title, movie.character]), [
    [49026, 'The Dark Knight Rises', ''],
  ]);
  assert.deepEqual(slim.photos, ['/a.jpg', '/b.jpg']);
  assert.equal(slim.external_ids.instagram_id, 'bryancranston');
  assert.equal(slim.external_ids.twitter_id, null);
  assert.equal(slim.shows[0].roles, undefined);
});

test('a director also gets their crew titles, with the job as the role', () => {
  const slim = slimPerson(person({ known_for_department: 'Directing' }));
  assert.equal(slim.shows[0].character, 'Walter White, Heisenberg, Director');
  assert.equal(slim.shows[0].episode_count, 65);
  assert.deepEqual(slim.movies.map((movie) => [movie.id, movie.character]), [[49026, ''], [777, 'Producer']]);
});

test('credit notes and roles inside a longer one are dropped', () => {
  const slim = slimPerson(person({
    combined_credits: {
      cast: ['Sharon Raydor', 'Captain Sharon Raydor', 'Sharon Raydor (archive footage) (uncredited)', 'Bert (voice)']
        .map((character) => ({ id: 5, media_type: 'tv', name: 'The Closer', character, episode_count: 1 })),
    },
  }));
  assert.equal(slim.shows[0].character, 'Captain Sharon Raydor, Bert (voice)');
});

test('missing pieces do not throw', () => {
  const slim = slimPerson({ id: 1 });
  assert.deepEqual([slim.shows, slim.movies, slim.photos], [[], [], []]);
  assert.equal(slim.birthday, null);
});
