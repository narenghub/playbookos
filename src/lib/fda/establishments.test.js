// FDA establishment parser + matcher tests — node --test src/lib/fda/establishments.test.js
// Fixtures are two real rows from drls_reg.txt, tabs and trailing empty field intact.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeName, firmCore, countryOf, isApiManufacturer, isUsAgent,
  parseDecrs, dedupeBySite, matchTier, reviewStatusFor,
} = require('./establishments');

const HEADER = ' FEI_NUMBER\tDUNS_NUMBER\tFIRM_NAME\tADDRESS\tEXPIRATION_DATE\tOPERATIONS\t'
  + 'ESTABLISHMENT_CONTACT_NAME\tESTABLISHMENT_CONTACT_EMAIL\tAGENT_DETAILS\tREGISTRANT_NAME\t'
  + 'REGISTRANT_DUNS\tREGISTRANT_CONTACT_NAME\tREGISTRANT_CONTACT_EMAIL\tEXCLUSION_FLAG';
// Verbatim shape: 15 fields, the last empty.
const ROW_FOREIGN = '0000000360\t271408412\tDSP\tRue Grands Navoirs, Chauny,  F-02300, France (FRA)\t'
  + '12/31/2026\tAPI MANUFACTURE\tSylvie Proisy\tsylvie.proisy@dupont.com\t'
  + '139242874 - Registrar Corp - drugs@registrarcorp.com\tDSP\t271408412\tDavid Lennarz\t'
  + 'drugs@registrarcorp.com\tN\t';
const ROW_DOMESTIC = '1419498\t123456789\tRising Pharma Holdings, Inc.\t'
  + '1222 West Grand Ave, Decatur, Illinois (IL) 62522, United States (USA)\t12/31/2026\t'
  + 'ANALYSIS; MANUFACTURE; PACK\tJane Roe\tjane.roe@risingpharma.com\t\t'
  + 'Rising Pharma Holdings\t123456789\tJohn Doe\tjohn.doe@risingpharma.com\tN\t';

test('parseDecrs reads the tab-separated file and drops the header', () => {
  const rows = parseDecrs([HEADER, ROW_FOREIGN, ROW_DOMESTIC].join('\n'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].firm_name, 'DSP');
  assert.equal(rows[0].fei_number, '0000000360');
  assert.equal(rows[0].establishment_contact_email, 'sylvie.proisy@dupont.com');
});

test('a file with no header keeps its first row', () => {
  // A parser that always skipped line 1 would lose a row and merely look short.
  const rows = parseDecrs([ROW_DOMESTIC].join('\n'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].firm_name, 'Rising Pharma Holdings, Inc.');
});

test('country is parsed from the address tail, and is null when absent', () => {
  assert.equal(countryOf('Rue Grands Navoirs, Chauny,  F-02300, France (FRA)'), 'FRA');
  assert.equal(countryOf('1222 West Grand Ave, Decatur, Illinois (IL) 62522, United States (USA)'), 'USA');
  // (IL) is a state code mid-string, not a country — only the TAIL counts.
  assert.equal(countryOf('1222 West Grand Ave, Decatur, Illinois (IL) 62522'), null);
  assert.equal(countryOf(''), null);
  assert.equal(countryOf(null), null);
});

test('API MANUFACTURE is detected inside a semicolon list', () => {
  assert.equal(isApiManufacturer('API MANUFACTURE'), true);
  assert.equal(isApiManufacturer('ANALYSIS; API MANUFACTURE; LABEL; PACK'), true);
  assert.equal(isApiManufacturer('ANALYSIS; MANUFACTURE; PACK'), false, 'MANUFACTURE alone is not API MANUFACTURE');
  assert.equal(isApiManufacturer('RELABEL; REPACK'), false);
  assert.equal(isApiManufacturer(null), false);
});

test('a third-party US agent is flagged, a real firm address is not', () => {
  assert.equal(isUsAgent('drugs@registrarcorp.com'), true);
  assert.equal(isUsAgent('john.doe@risingpharma.com'), false);
  assert.equal(isUsAgent(''), false);
  assert.equal(isUsAgent(null), false);
});

test('the foreign row keeps a REAL establishment contact even though its registrant is an agent', () => {
  // The distinction the whole flag exists for: the plant contact is a person at DuPont, the
  // registrant mailbox is Registrar Corp. Mailing the latter reaches an intermediary.
  const [dsp] = parseDecrs([HEADER, ROW_FOREIGN].join('\n'));
  assert.equal(dsp.is_us_agent, true);
  assert.equal(dsp.registrant_contact_email, 'drugs@registrarcorp.com');
  assert.equal(dsp.establishment_contact_email, 'sylvie.proisy@dupont.com');
  assert.equal(dsp.is_api_manufacturer, true);
  assert.equal(dsp.country, 'FRA');
});

test('a malformed line is skipped rather than throwing', () => {
  const rows = parseDecrs([HEADER, 'not\ta\trow', ROW_DOMESTIC].join('\n'));
  assert.equal(rows.length, 1);
  assert.equal(parseDecrs('').length, 0);
  assert.equal(parseDecrs(null).length, 0);
});

test('normalizeName and firmCore fold the way the join needs', () => {
  assert.equal(normalizeName('Rising Pharma Holdings, Inc.'), 'rising pharma holdings inc');
  // firmCore drops the industry and corporate vocabulary that carries no identity
  assert.equal(firmCore('Rising Pharma Holdings, Inc.'), 'rising');
  assert.equal(firmCore('KINGCHEM LABORATORIES INC'), 'kingchem');
});

test('matchTier: exact and core join, everything else does NOT', () => {
  assert.equal(matchTier('KINGCHEM LABORATORIES INC', 'Kingchem Laboratories Inc.'), 'exact');
  assert.equal(matchTier('SYMBIO GENERRICS INDIA PRIVATE LTD', 'Symbio Generrics India Private Limited'), 'core');
  // The measured noise the looser tiers produced — these must NOT join.
  assert.equal(matchTier('TIANJIN BIOSEPUR PURIFICATION EQUIPMENT', "Alick's Home Medical Equipment"), null);
  assert.equal(matchTier('FUJI CHEMICAL INDUSTRIES CO LTD', 'Fuji Electric Co., Ltd.'), null);
  assert.equal(matchTier('RISING PHARMA HOLDINGS INC', 'Rising Sun Pictures'), null);
  assert.equal(matchTier('', 'Anything'), null);
  assert.equal(matchTier('Anything', ''), null);
});

test('a group entity does not silently join to a sibling establishment', () => {
  // Baxter Oncology GmbH really holds DMFs; the register lists other Baxter entities. A
  // matcher cannot tell that from a coincidence, so it must decline rather than guess.
  assert.equal(matchTier('BAXTER ONCOLOGY GMBH', 'Baxter Healthcare Ltd'), null);
  assert.equal(matchTier('SANOFI AVENTIS US INC', 'Sanofi Winthrop Industrie'), null);
});

test('only exact and core are auto-confirmed', () => {
  assert.equal(reviewStatusFor('exact'), 'auto_confirmed');
  assert.equal(reviewStatusFor('core'), 'auto_confirmed');
  assert.equal(reviewStatusFor('not_found'), 'unreviewed');
  assert.equal(reviewStatusFor(null), 'unreviewed');
});

test('dedupeBySite UNIONS operations, so a site never loses API MANUFACTURE', () => {
  // The real Lifecore rows: same firm, same FEI, same address, different operation sets.
  const key = r => `${r.fei_number}|${r.firm_name}|${r.address}`;
  const rows = [
    { fei_number: '1000115753', firm_name: 'Lifecore Biomedical, LLC', address: 'X',
      operations: 'MANUFACTURE', is_api_manufacturer: false, is_us_agent: false,
      duns_number: null, establishment_contact_email: null, registrant_name: null,
      registrant_contact_email: null, exclusion_flag: null },
    { fei_number: '1000115753', firm_name: 'Lifecore Biomedical, LLC', address: 'X',
      operations: 'ANALYSIS; API MANUFACTURE; LABEL', is_api_manufacturer: true, is_us_agent: false,
      duns_number: '9', establishment_contact_email: 'q@lifecore.com', registrant_name: null,
      registrant_contact_email: null, exclusion_flag: null },
  ];
  const out = dedupeBySite(rows, key);
  assert.equal(out.length, 1);
  assert.equal(out[0].operations, 'ANALYSIS; API MANUFACTURE; LABEL; MANUFACTURE');
  // recomputed from the MERGED set — the first row said false
  assert.equal(out[0].is_api_manufacturer, true);
  // a present value fills a null one
  assert.equal(out[0].duns_number, '9');
  assert.equal(out[0].establishment_contact_email, 'q@lifecore.com');
});

test('dedupeBySite leaves genuinely distinct sites alone', () => {
  const key = r => `${r.fei_number}|${r.firm_name}|${r.address}`;
  const mk = (addr) => ({ fei_number: '1', firm_name: 'Acme', address: addr,
    operations: 'API MANUFACTURE', is_api_manufacturer: true, is_us_agent: false });
  assert.equal(dedupeBySite([mk('Site A'), mk('Site B')], key).length, 2);
  assert.equal(dedupeBySite([], key).length, 0);
});
