const test = require('node:test');
const assert = require('node:assert');
const { MARKETS, marketSql, marketOf, marketLabel, isMarket } = require('./markets');

test('eu binds the ISO-3 list as one array parameter', () => {
  const m = marketSql('eu', 1);
  assert.match(m.sql, /country = ANY\(\$1\)/);
  assert.equal(m.params.length, 1);
  assert.ok(Array.isArray(m.params[0]));
  assert.ok(m.params[0].includes('ITA'));
  assert.ok(m.params[0].includes('DEU'));
  assert.ok(!m.params[0].includes('USA'));
  assert.equal(m.nextIndex, 2);
});

test('us treats a NULL country as domestic and binds nothing', () => {
  const m = marketSql('us', 3);
  assert.match(m.sql, /country IS NULL/);
  assert.deepEqual(m.params, []);
  // Consumes no placeholder, so a caller composing a LIMIT must get its index back unchanged.
  assert.equal(m.nextIndex, 3);
});

test('all is a no-op clause that still composes', () => {
  const m = marketSql('all', 2);
  assert.equal(m.sql, 'TRUE');
  assert.deepEqual(m.params, []);
  assert.equal(m.nextIndex, 2);
});

test('an unknown market falls back to all rather than silently selecting nothing', () => {
  // A hand-typed query parameter must not produce an empty list that reads as "nobody is here".
  assert.equal(marketSql('eurp', 1).sql, 'TRUE');
});

test('marketOf agrees with marketSql about every case the SQL covers', () => {
  assert.equal(marketOf(null), 'us');
  assert.equal(marketOf('USA'), 'us');
  assert.equal(marketOf('ITA'), 'eu');
  assert.equal(marketOf('GBR'), 'eu');      // EUROPE is EU/EEA + UK + EFTA, deliberately
  assert.equal(marketOf('IND'), 'row');
  assert.equal(marketOf('CHN'), 'row');
});

test('labels and validity', () => {
  assert.equal(marketLabel('eu'), 'EU');
  assert.equal(marketLabel('row'), 'rest of world');
  assert.ok(isMarket('us') && isMarket('eu') && isMarket('all'));
  assert.ok(!isMarket('row'));             // a storable value, not a selectable filter
  assert.ok(!isMarket(''));
  assert.deepEqual(MARKETS, ['us', 'eu', 'all']);
});
