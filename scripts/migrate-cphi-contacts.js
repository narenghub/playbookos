// ── CPHI: the people you actually met, and the meeting state ──────────────────
//
// The exhibitor-match table answers "is this DMF holder on the floor, and where". It says nothing
// about whether you spoke to them or who you spoke to, which is the only part that survives the
// show. This adds that.
//
//   node scripts/migrate-cphi-contacts.js
//
// ── WHY CONTACTS HANG OFF THE EVENT, NOT OFF THE MATCH ───────────────────────
//
// `exhibitor_match_id` is NULLABLE and `company` is NOT NULL. Half the cards collected in Milan
// are from firms that are not DMF holders at all — a CDMO, a Taiwanese intermediate maker, a
// Chinese supplier whose email domain does not match its trading name. If a contact could only
// exist against a matched row, every one of those would be dropped on import, and the card in the
// pocket is the whole value of the trip.
//
// So a contact is an event fact. When it CAN be tied to an exhibitor row it is, and the page shows
// it on that row; when it cannot, it still exists and is still reachable.
//
// ── AND WHY THE MEETING STATE IS ON THE MATCH ────────────────────────────────
//
// "Did we meet them" is a fact about the company at this event, not about one person, and it is
// what the floor list is filtered by on day 2 and day 3. It sits on the match row so the priority
// table can grey out the booths already worked without a join.
//
// Manual rollback:
//   DROP TABLE IF EXISTS cphi_exhibitor_contacts;
//   ALTER TABLE cphi_exhibitor_matches
//     DROP COLUMN IF EXISTS met_in_person, DROP COLUMN IF EXISTS met_at,
//     DROP COLUMN IF EXISTS linkedin_connected, DROP COLUMN IF EXISTS meeting_note;

const { initDB, query } = require('../src/lib/db');

async function migrate() {
  await initDB();

  await query(`
    CREATE TABLE IF NOT EXISTS cphi_exhibitor_contacts (
      id                  BIGSERIAL PRIMARY KEY,
      event_slug          TEXT NOT NULL,
      -- Nullable ON PURPOSE: a card from a firm with no DMF match is still a card. See the header.
      exhibitor_match_id  BIGINT REFERENCES cphi_exhibitor_matches(id) ON DELETE SET NULL,
      company             TEXT NOT NULL,        -- as printed on the card, which may differ from the stand
      company_normalized  TEXT NOT NULL,        -- fold, so a re-import updates instead of duplicating
      name                TEXT NOT NULL,
      title               TEXT,
      email               TEXT,
      phone_mobile        TEXT,
      phone_office        TEXT,
      website             TEXT,
      address             TEXT,
      source              TEXT,                 -- card | QR vCard | digital card | typed
      note                TEXT,                 -- anything to confirm before contracting
      linkedin_connected  BOOLEAN NOT NULL DEFAULT FALSE,
      last_emailed_at     TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- One row per person per company per event. A re-run of the seed refreshes rather than
    -- doubling, and a person who moves company gets their own row, which is correct.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cec_unique
      ON cphi_exhibitor_contacts (event_slug, company_normalized, lower(name));
    CREATE INDEX IF NOT EXISTS idx_cec_match ON cphi_exhibitor_contacts (exhibitor_match_id);
    CREATE INDEX IF NOT EXISTS idx_cec_event ON cphi_exhibitor_contacts (event_slug);
  `);

  // Meeting state on the match row — see the header for why it lives here.
  await query(`
    ALTER TABLE cphi_exhibitor_matches
      ADD COLUMN IF NOT EXISTS met_in_person     BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS met_at            TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS linkedin_connected BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS meeting_note      TEXT;
  `);

  const n = (await query(`SELECT COUNT(*)::int n FROM cphi_exhibitor_contacts`)).rows[0].n;
  console.log(`✅ CPHI contacts schema applied. cphi_exhibitor_contacts holds ${n} row(s).`);
  process.exit(0);
}

migrate().catch(e => { console.error('CPHI contacts migration error:', e.message); process.exit(1); });
