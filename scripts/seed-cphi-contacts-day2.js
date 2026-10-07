// ── CPHI Milan 2026: the cards collected on day 2 ─────────────────────────────
//
//   node scripts/seed-cphi-contacts-day2.js            # DRY RUN — shows what ties to which booth
//   node scripts/seed-cphi-contacts-day2.js --write    # insert/update
//
// Transcribed from the physical cards, one WhatsApp contact and one digital vCard collected on
// 7 October 2026. Same rules as day 1 (scripts/seed-cphi-contacts.js): every field as printed,
// nothing inferred, and where a card is ambiguous the ambiguity goes into `note` rather than being
// resolved by guessing — a wrong legal entity on a supply contract is expensive and a note is free.
//
// ── WHY THIS IS A SEPARATE FILE ──────────────────────────────────────────────
//
// It shares the matcher, the table and the unique key with day 1, so the two cannot disagree about
// what a company is or produce a duplicate contact. It is separate only so that a re-run of one
// day's import cannot touch the other day's rows, and so the provenance of each batch stays legible
// a year from now.
//
// ── TEN ROWS ARE FLAGGED FOR A HUMAN ─────────────────────────────────────────
//
// Read the notes before any of this goes into a sequence. The flags are of three kinds:
//   • A DIGIT OR A DOMAIN THAT COULD NOT BE READ from the photograph (Zydus mobile, Moehs
//     handwritten email, Harbin Jixianglong email domain, Divi's numbers).
//   • A NAME THAT DISAGREES WITH ITS OWN EMAIL (Thinheal, Hetero-style mismatches) — these are
//     usually a colleague's address on a reprinted card, and sending to the wrong one is noticed.
//   • A COMPANY THAT IS NOT YET IDENTIFIED (John Siegel, and the WhatsApp contact saved as "BNMR").
//
// IDEMPOTENT: unique on (event, company fold, lower(name)), so a re-run refreshes.

const { initDB, query } = require('../src/lib/db');
const { normalizeCompany, companyCore } = require('../src/lib/cphi/match-company');

const EVENT = 'cphi-milan-2026';
const WRITE = process.argv.includes('--write');

const CARDS = [
  { company: 'ScinoPharm Taiwan Ltd', name: 'Candice Lee',
   title: 'Account Manager, API Sales — Marketing & Sales Division', email: 'candice.lee@scinopharm.com',
   mobile: '+886 909 560 919', office: '+886 6 505 2888 ext 2964',
   address: 'No. 1, Nan-Ke 8th Road, Shan-Hua, Tainan 74144, Taiwan', source: 'card',
    note: 'Two ScinoPharm cards taken — Candice Lee (API Sales) and Erin Chang (API Business). Same'
      + ' division, same site. Fax +886 6 505 2855.' },

  { company: 'ScinoPharm Taiwan Ltd', name: 'Erin Chang',
   title: 'Manager, API Business — Marketing & Sales Division', email: 'Erin.Chang@scinopharm.com',
   mobile: '+886 930 559 337', office: '+886 6 508 2888 ext 2967',
   address: 'No. 1, Nan-Ke 8th Road, Shan-Hua, Tainan 74144, Taiwan', source: 'card',
    note: 'CHECK OFFICE NUMBER: card reads 6 508 2888 where Candice Lee\'s reads 6 505 2888. One of the two'
      + ' is likely a misprint; the shared fax is 6 505 2855. Fax +886 6 505 2855.' },

  { company: 'CENRA+ API Solutions', name: 'Wayne Hsiao', title: 'President',
   email: 'wayne.hsiao@ccsb.com.tw', office: '+886 2 8684 3318 #800',
   address: 'No. 1, Dongxing St., Shulin Dist., New Taipei City 238010, Taiwan', source: 'card',
    note: 'CONFIRM LEGAL ENTITY: card brands CENRA+ API Solutions / 中化合成, email domain is ccsb.com.tw'
      + ' (China Chemical & Pharmaceutical / CCSB). Chinese name 蕭文郁. Tax ID 03088704. President — most'
      + ' senior person met on day 2. Fax +886 2 8686 0502.' },

  { company: 'Sinopep-Allsino Biopharmaceutical Co., Ltd', name: 'Miya Wei', title: 'Sales Director',
   email: 'jinyu.wei@sinopep.com', mobile: '+86 15397155059', website: 'www.sinopep.com',
   address: 'STE 1201, Bldg E, 1378 West Wenyi Road, Hangzhou, Zhejiang 311121, China', source: 'card',
    note: 'Stock code 688076. Plant: 28 Linyu Road, Lianyungang Economic & Technological Development Zone,'
      + ' Jiangsu 222000. Peptides. Second Sinopep card taken — see Ella Guo. WhatsApp +86 13486390089.' },

  { company: 'Sinopep-Allsino Biopharmaceutical Co., Ltd', name: 'Ella Guo',
   title: 'Senior Director of Business Development', email: 'ella@sinopep.com', website: 'www.sinopep.com',
   source: 'card',
    note: 'Stock code 688076. More senior than Miya Wei — lead with Ella Guo and copy Miya Wei. WhatsApp'
      + ' +86 150 6888 4124.' },

  { company: 'Aarti Pharmalabs Limited', name: 'Malay Nandu', title: 'DGM — Marketing',
   email: 'malay.nandu@aartipharmalabs.com', mobile: '+91 97692 91091', office: '+91 22 6943 6312',
   address: 'Embassy Park 247, Tower C, 401, 4th Floor, LBS Marg, Vikhroli (W), Mumbai 400 083, Maharashtra, India',
   source: 'card',
    note: 'Main board +91 22 6943 6100. Card carries a QR vCard.' },

  { company: 'Aurisco Pharmaceutical Co., Ltd', name: 'Vincent Zhu',
   title: 'Regional Sales Director — Business Department, Shanghai Office', email: 'zhuzhengyu@aurisco.com',
   mobile: '+86 13818443578', office: '+86 21 5298 7136 ext 335', website: 'www.aurisco.com',
   address: '17F, Hitech Plaza, No. 488 S. Wu Ning Road, Shanghai 200042, China', source: 'card' },

  { company: 'Chieron', name: 'Sajan Kumar Chatarla', title: 'Manager — Sales & Marketing',
   email: 'sajan@chieron.com', mobile: '+91 96188 35867', website: 'www.chieron.com',
   address: 'NCC Building, 3rd Floor, East Wing, Madhapur, Hitech City, Hyderabad 500081, India',
   source: 'card',
    note: 'CONFIRM ENTITY: card shows both www.chieron.com and www.glochemindia.com. Chieron and Glochem'
      + ' India appear to be related; ask which entity supplies. Alt mobile +91 89259 87047.' },

  { company: 'Hisun Pharmaceuticals USA, Inc.', name: 'Phoebe Zhang',
   title: 'Head of Sales, Overseas FDF — Global Sales & Marketing', email: 'tijun.zhang@hisunpharm.com',
   mobile: '+86 139 2170 6326', address: '200 Crossing Boulevard, 2nd Floor, Bridgewater, NJ 08807, USA',
   source: 'card',
    note: 'US entity on the card, China office at 381 Fengjin Rd, Xuhui Dist, Shanghai 200032. FDF rather'
      + ' than API — a finished-dose conversation.' },

  { company: 'Laurus Labs Limited', name: 'Mudit Singhal', title: 'Senior Director, Business Development',
   email: 'mudit.singhal@lauruslabs.com', mobile: '+1 551 332 9178', office: '+1 833 3LAURUS',
   website: 'www.lauruslabs.com', address: '400 Connell Drive, Suite 5200, Berkeley Heights, NJ 07922, USA',
   source: 'card',
    note: 'US-based BD for an Indian API major — the easiest first call on this list for a US buyer.' },

  { company: 'Jiangsu Hansoh Pharmaceutical Group Co., Ltd', name: 'Vivien Lee',
   title: 'Manager, International Business Division', email: 'vivien.lee@hspharm.com',
   mobile: '+86 186 5210 9847', website: 'www.hansoh.cn',
   address: '9 Dongjin Road, Economic & Technical Development Zone, Lianyungang, Jiangsu 222069, China',
   source: 'card' },

  { company: 'Alembic Pharmaceuticals Ltd', name: 'Bhargav Bhatt',
   title: 'Deputy General Manager, Business Development (API)', email: 'bhargav.bhatt@alembic.co.in',
   mobile: '+91 99252 20344', office: '+91 265 663 7838', website: 'www.alembicpharmaceuticals.com',
   address: 'Alembic Road, Vadodara 390003, Gujarat, India', source: 'card' },

  { company: 'ChemWerth Inc.', name: 'Jonathan Werth Moore', title: 'Sales Manager',
   email: 'jon.moore@chemwerth.com', mobile: '+1 860 930 0301', office: '+1 203 392 0466',
   website: 'www.chemwerth.com', address: '1764 Litchfield Turnpike, Woodbridge, CT 06525, USA',
   source: 'card',
    note: 'Main line +1 203 387 7794. US API distributor/developer rather than a manufacturer — they source'
      + ' on behalf of buyers, so this is a channel conversation as much as a supply one.' },

  { company: 'Macleods Pharmaceuticals Ltd', name: 'Swati Thakarda',
   title: 'International Business — API Sales', email: 'swati@macleodspharma.com',
   mobile: '+91 89767 79907', office: '+91 22 2667 2800', website: 'www.macleodspharma.com',
   address: 'Atlanta Arcade, Church Road, Near Leela Hotel, Andheri-Kurla Road, Andheri (E), Mumbai 400 059, India',
   source: 'card',
    note: 'Fax +91 22 2925 6599.' },

  { company: 'RaaLi Tide Biological Tech (Weihai) Co., Ltd', name: 'Baffy Xu',
   title: 'Global Business Director', email: 'baffy.x@ritbio.cn', mobile: '+86 135 5117 3777',
   website: 'www.ritbio.cn', address: 'North Longhai Road, Nanhai New Area, Weihai City, Shandong, China',
   source: 'card',
    note: 'Brand on the card is RJ Bio / 润臻生物. Peptides.' },

  { company: 'Zydus Lifesciences Limited', name: 'Sonia Raut',
   title: 'Assistant Manager — Marketing (API), Europe', email: 'sonia.raut@zyduslife.com',
   mobile: '+91 73763 69?', office: '+91 265 231 5239', website: 'www.zyduslife.com', source: 'card',
    note: 'MOBILE INCOMPLETE — last digits unclear in the photo, re-read the card. Europe remit; will need'
      + ' a US counterpart introduction.' },

  { company: 'Zhuohe Pharmaceutical Group Co., Ltd', name: 'Levin Lee',
   title: 'International Trade — Senior BD Manager', email: 'sales@zh-brimed.com',
   mobile: '+86 181 6886 1533', website: 'www.zh-brimed.com',
   address: 'No. 219 Fufeng Middle Road, Xishan Economic Zone, Wuxi City, Jiangsu, China', source: 'card',
    note: 'Brand BRIMED. Owned subsidiary: Wuxi Fortune Pharmaceutical Co., Ltd — hence the second email'
      + ' domain. Alt email bdg@wxfortune.com.cn.' },

  { company: 'Suzhou Tianma Pharma Group Tianji Biopharmaceutical Co., Ltd', name: 'Daniel Zhao',
   title: 'Sales Manager', email: 'daniel.zhao@tianmapharma.com', mobile: '+86 158 5078 8624',
   office: '+86 512 6832 2275', website: 'www.tianjibio.com', address: '77 Haichuang Rd, Changshu, China',
   source: 'card',
    note: 'Card prints the given name only ("Daniel"); surname taken from the email. Polypeptide drugs.' },

  { company: 'Alivus Life Sciences Limited', name: 'Sachin Uttekar', title: 'Vice President, Procurement',
   email: 'Sachin.Uttekar@alivus.com', mobile: '+91 99207 55336', office: '+91 22 6829 7979 ext 19765',
   website: 'www.alivus.com',
   address: 'Technopolis Knowledge Park, A Wing, 4th Floor, Hanuman Nagar, Mahakali Caves Road, Andheri East, Mumbai 400 093, Maharashtra, India',
   source: 'card',
    note: 'Formerly Glenmark Life Sciences. PROCUREMENT, not sales — he buys. That makes this a BUYER'
      + ' conversation for the marketplace, not a supplier one.' },

  { company: 'Zhejiang Thinheal Pharmaceutical Technology Co., Ltd', name: 'Xia Xiaoqin',
   title: 'Sales Manager', email: 'niexiaoqin@thinheal.com', mobile: '+86 136 2847 6528',
   office: '+86 571 8675 8863', website: 'www.thinhealpeptide.com',
   address: 'Building 7/8, No. 2, Heda Yaogu Phase 5, 1160 Guofu Street, Xiasha, Qiantang District, Hangzhou, Zhejiang, China',
   source: 'card',
    note: 'CHECK NAME vs EMAIL: card prints 夏晓琴 (Xia Xiaoqin) but the email reads niexiaoqin@. Also trades'
      + ' as 浙江肽昇生物医药有限公司. Peptides.' },

  { company: 'Harbin Jixianglong Biotech Co., Ltd', name: 'Lina', title: 'Sales Manager',
   email: 'lina@hrbjxl.cn', mobile: '+86 199 1758 1677', office: '+86 451 5877 4179',
   address: 'Limin Development Zone, Harbin 150025, China', source: 'card',
    note: 'VERIFY EMAIL DOMAIN — hrbjxl.cn vs hrbjxl.com, both printed and hard to read. Peptides. Mobile'
      + ' is also WhatsApp. Alt email sales02@hrbjxl.com.' },

  { company: 'Piramal Pharma Limited', name: 'Shreeram Kanetkar', title: 'Business Head, API Generics',
   email: 'shreeram.kanetkar@piramal.com', mobile: '+91 99740 51188', website: 'piramalpharmasolutions.com',
   address: 'Piramal Ananta, Agastya Corporate Park, Opp Fire Brigade, Kamani Junction, LBS Marg, Kurla (West), Mumbai 400070, Maharashtra, India',
   source: 'card',
    note: 'Business Head — senior. Piramal is also a CDMO, so this is both a supply and a partner'
      + ' conversation.' },

  { company: 'Duorui Biopharmaceutical', name: 'Rejina Huang', title: 'Sales Manager',
   email: 'ruirui.huang@duoruipharm.com', mobile: '+86 133 9836 7154', website: 'www.duoruipharm.com',
   address: 'No. 76, Jinle Road, Chengdu-Aba Industrial Concentrated Development Zone, Jintang County, Chengdu, Sichuan, China',
   source: 'card',
    note: 'Peptide and oligonucleotide APIs.' },

  { company: 'Maithri Drugs Private Limited', name: 'Gopi Krishna Nekkalapudi',
   title: 'Manager — Business Development', email: 'gopin@maithridrugs.com', mobile: '+91 90592 44566',
   office: '+91 40 6907 6600', website: 'www.maithridrugs.com',
   address: 'Dwaraka Signature, Plot No. 14D/1, 2nd Floor, Jaihind Enclave, Madhapur, Hyderabad 500 081, Telangana, India',
   source: 'card',
    note: 'Alt mobile +91 97006 02423.' },

  { company: 'Shilpa Pharma Lifesciences Ltd', name: '(no individual named)', source: 'card',
    note: 'NAMED CONTACT MISSING — company card only, no person\'s name on it. Offers API, analytical services, CDMO/CRDMO,'
      + ' enzymes, fermentation, peptides, polymers, speciality chemicals. The analytical services line'
      + ' makes this a LabConnect conversation as well as a supply one. Needs a named contact before any'
      + ' outreach.' },

  { company: 'Sichuan Elixir Pharmaceutical Co., Ltd', name: 'Yinghong Yang', title: 'R&D Deputy Director',
   email: 'yangyh@elixir-pharm.com', mobile: '+86 177 2332 2465', office: '+86 28 8910 8610',
   website: 'www.elixir-pharm.com',
   address: 'Room 2018/2019, Building M3, Huanhui Commercial Plaza, No. 300 Jiaozi Avenue, High-Tech Zone, Chengdu, Sichuan, China',
   source: 'card',
    note: 'R&D rather than sales — the right person for a technical or development question, not a price.' },

  { company: 'SCI Pharmtech, Inc.', name: 'Laura Yang', title: 'Sales Representative — Business Department',
   email: 'laura.yang@sci-pharmtech.com.tw', office: '+886 3 354 3133', website: 'www.sci-pharmtech.com.tw',
   address: 'No. 61, Ln. 309, Haihu N. Rd., Luzhu Dist., Taoyuan City 33856, Taiwan', source: 'card',
    note: 'Fax +886 3 354 3137 ext 217.' },

  { company: 'EUROAPI', name: 'Nicolas Giel', title: 'General Manager, North America',
   email: 'nicolas.giel@euroapi.com', mobile: '+1 908 304 1049',
   address: '100 Somerset Corporate Blvd, 2nd Floor, Bridgewater, NJ 08807, USA', source: 'card',
    note: 'Sanofi\'s spun-out API business. GM North America — senior, US-based, and a European'
      + ' manufacturer. One of the strongest cards from day 2.' },

  { company: 'Shanxi Tongda Pharmaceutical Co., Ltd', name: 'Charlie Zhang',
   title: 'BD Director — Peptide Business Development', email: '13738002232@163.com',
   mobile: '+86 137 3800 2232', website: 'www.tongyaojituan.cn',
   address: 'The First Medical Zone, Datong Economic Technology Development Area, Shanxi Province 037300, China',
   source: 'card',
    note: 'Personal 163.com address rather than a company domain — ask for a company email before sending'
      + ' anything formal. Second Tongda card taken; see Shuling Zong.' },

  { company: 'Shanxi Tongda Pharmaceutical Co., Ltd', name: 'Shuling Zong',
   title: 'Sales Director — Peptide Business Development', email: 'zsl@tongtaibio.com',
   mobile: '+86 150 8863 0931', website: 'www.tongyaojituan.cn',
   address: 'The First Medical Zone, Datong Economic Technology Development Area, Shanxi Province 037300, China',
   source: 'card',
    note: 'Email domain tongtaibio.com differs from the printed website tongyaojituan.cn — likely a group'
      + ' company. Sales Director outranks the BD Director card; lead here.' },

  { company: 'Moehs Ibérica, S.L.', name: 'Eva del Alamo', title: 'Area Manager — Sales Department',
   email: 'edelalamo@moehs.es', mobile: '+34 687 418 423', office: '+34 935 868 520',
   address: 'Pol. Ind. Can Solera, C/ Roma 8-12, 08191 Rubí, Barcelona, Spain', source: 'card',
    note: 'EMAIL IS HANDWRITTEN on the card and the address is partly illegible in the photo — verify both'
      + ' before sending. Spanish API manufacturer; an EU supplier worth having. Alt office +34 935 868'
      + ' 521 ext 2040.' },

  { company: 'Reliance Life Sciences', name: 'Murtaza Jangbarwala',
   title: 'Senior Manager — Corporate Development', email: 'murtaza.jangbarwala@relbio.com',
   mobile: '+91 70218 71472', office: '+91 22 3533 8137', website: 'www.rellife.com',
   address: 'Dhirubhai Ambani Life Sciences Centre, Thane–Belapur Road, Rabale, Navi Mumbai 400 701, India',
   source: 'card',
    note: 'Board +91 22 3533 8000. Corporate Development — a partnership conversation rather than a product'
      + ' one.' },

  { company: 'Divi\'s Laboratories Limited', name: 'Neetu Jasti', title: 'DGM — Key Account Relationships',
   email: 'neetu@divislabs.com', mobile: '+1 973 900 3018', office: '+91 40 6696 6423',
   website: 'divislabs.com', source: 'card',
    note: 'CHECK NUMBERS: a US number (+1 973 476-5855 or 900-3018) and an Indian landline are both printed'
      + ' and partly unclear. Key accounts at Divi\'s — one of the largest API makers in the world.' },

  { company: 'Zhejiang Peptides Biotech Co., Ltd', name: 'Chutian Zhang', title: 'BD Director, PhD',
   email: 'chutian.zhang@peptide-china.com', mobile: '+86 137 6431 6281', website: 'www.peptide-china.com',
   address: 'No. 8, Hengyi Rd, Sanjie Hi-tech Park, Shengzhou, Zhejiang, China', source: 'card' },

  { company: 'Indena S.p.A.', name: 'Edwin Heavisides',
   title: 'Sales Manager — North America, UK/IE, South Africa', email: 'edwin.heavisides@indena.com',
   mobile: '+39 340 153 6518', office: '+39 02 574396 408', website: 'indena.com',
   address: 'Viale Ortles 12, 20139 Milan, Italy', source: 'card',
    note: 'Botanical and plant-derived actives. Milan-based, and his remit covers North America — an easy'
      + ' follow-up while you are still in the city.' },

  { company: 'Olon S.p.A.', name: 'Nureddin Mansour', title: 'Area Manager — BU Generics',
   email: 'nureddin.mansour@olon-usa.com', mobile: '+1 973 407 0559', website: 'www.olonspa.com',
   address: '100 Campus Drive, Florham Park, NJ 07932, USA', source: 'card',
    note: 'Italian API major with a US arm. US mobile and US entity — straightforward to follow up from'
      + ' Chicago.' },

  { company: 'Sichuan Kelun Pharmaceutical Co., Ltd', name: 'Ming Zhang',
   title: 'Sales, International Sales Department — Licensed Pharmacist', email: 'ming.zhang@kelun.com',
   mobile: '+86 135 0035 4375', website: 'www.kelun.com',
   address: 'No. 36, West Baihua Road, Qingyang District, Chengdu, Sichuan 610071, China', source: 'card',
    note: 'Card prints the English given name "Thomson"; full name taken from the email. Stock code'
      + ' 002422.SZ.' },

  { company: 'Suzhou Motif Biotech Co., Ltd', name: 'Tiger Hu', title: 'Director of Overseas Business Unit',
   email: 'tigerhu@motifbiotech.com', mobile: '+86 176 2101 6868',
   address: 'B04, Building 17, No. 122 Yongan Rd, Suzhou National Hi-Tech District, China', source: 'card',
    note: 'Chinese name 虎若南. Second Motif card taken — see Xuguang Zhang, who is more senior.' },

  { company: 'Suzhou Motif Biotech Co., Ltd', name: 'Xuguang Zhang', title: 'Executive Vice President',
   email: 'zhangxuguang@motifbiotech.com', mobile: '+86 185 1610 7567',
   address: 'B04, Building 17, No. 122 Yongan Rd, Suzhou National Hi-Tech District, China', source: 'card',
    note: 'Chinese name 张旭光. EVP — lead here and copy Tiger Hu.' },

  { company: 'Umicore AG & Co. KG', name: 'Knut Fehl',
   title: 'Global Commercial Head — Precious Metals Chemistry', email: 'knut.fehl@eu.umicore.com',
   mobile: '+49 175 7212 956', website: 'www.umicore.com',
   address: 'Rodenbacher Chaussee 4, 63457 Hanau-Wolfgang, Germany', source: 'card',
    note: 'Precious-metal catalysts, not APIs — relevant to a manufacturer\'s process chemistry rather than'
      + ' to sourcing finished molecules. Global commercial head, so a senior contact to keep.' },

  { company: 'Veranova', name: 'Julien Kubrijanow',
   title: 'Director, Sales & Business Development North America — Generics',
   email: 'julien.kubrijanow@veranova.com', mobile: '+1 514 231 3165', website: 'veranova.com',
   address: '2003 Nolte Drive, West Deptford, NJ 08066, USA', source: 'card',
    note: 'CDMO. North America generics remit — both a supply and a partner conversation.' },

  { company: 'Changzhou Pharmaceutical Factory', name: 'Cheng Yayun',
   title: 'Sales Director — EU, North America, Africa & Turkey', email: 'chengyayun@czpharma.com',
   mobile: '+86 132 9133 7572', office: '+86 519 8882 8412', website: 'www.czpharma.com',
   address: 'No. 518 Laodong East Road, Changzhou, Jiangsu 213018, China', source: 'card',
    note: 'Part of SPH / Shanghai Pharma; also trades as Nantong Chanyoo Pharmatech. Second card from the'
      + ' same factory — see Zhu Yijun. Mobile is also WhatsApp. Fax +86 519 8882 1493.' },

  { company: 'Changzhou Pharmaceutical Factory', name: 'Zhu Yijun',
   title: 'General Manager — Tides & Biology BU, PhD', email: 'zhuyi@czpharma.com',
   mobile: '+86 136 3636 2064', office: '+86 519 8882 8412', website: 'www.czpharma.com',
   address: 'No. 518 Laodong East Road, Changzhou, Jiangsu 213018, China', source: 'card',
    note: 'General Manager of the peptides business unit — more senior than the sales director card, and'
      + ' the right person for peptide capacity.' },

  { company: 'Synthon', name: 'Rob van Alst', title: 'Director Sales Development, North America',
   email: 'rob.vanalst@synthon.com', mobile: '+31 6 10 62 66 50', website: 'www.synthon.com',
   source: 'digital card',
    note: 'Shared as a digital contact card, not paper — every field came across clean. Dutch generics'
      + ' developer with a North America remit. LinkedIn linkedin.com/in/robvanalst.' },

  { company: 'Gland Chemicals Pvt Ltd', name: '(name unknown — saved as "BNMR")', mobile: '+91 93467 29196',
   website: 'glandchemicals.in',
   address: 'Plot No. 218, Road No. 17, Jubilee Hills, Hyderabad 500033, Telangana, India',
   source: 'whatsapp',
    note: 'NAME STILL MISSING — only a WhatsApp number saved as "BNMR". Registered as GLAND CHEMICALS PVT'
      + ' LTD, CIN U24110TG1974PTC001694, incorporated 15 March 1974, activity "manufacture of chemicals'
      + ' and chemical products". NOT Gland Pharma Limited, which is a separate and much larger company —'
      + ' do not conflate the two on any document. Ask on WhatsApp for a name and a company email before'
      + ' adding to any sequence. Mobile is also WhatsApp.' },

  { company: '(company unknown)', name: 'John Siegel', mobile: '+1 310 480 3190', source: 'whatsapp',
    note: 'COMPANY UNKNOWN — saved from WhatsApp with no card and no company. US mobile, Los Angeles area'
      + ' code. I have not looked this number up: tracing a private mobile is not something to do from a'
      + ' photo. Message him and ask which company he is with before this row is used for anything. Mobile'
      + ' is also WhatsApp.' },
];

const pad = (s, n) => String(s == null ? '' : s).padEnd(n).slice(0, n);

async function main() {
  await initDB();

  const matches = (await query(
    `SELECT id, holder, holder_normalized, booth, hall, exhibiting, molecules_covered
       FROM cphi_exhibitor_matches WHERE event_slug = $1 AND role = 'supplier'`, [EVENT])).rows;

  const byNorm = new Map(), byCore = new Map();
  for (const m of matches) {
    const norm = normalizeCompany(m.holder);
    const core = companyCore(m.holder);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, m);
    if (core) {
      const prev = byCore.get(core);
      if (!prev || (m.molecules_covered || 0) > (prev.molecules_covered || 0)) byCore.set(core, m);
    }
  }

  console.log(`\n── ${CARDS.length} day-2 cards against ${matches.length} exhibitor rows ──────────────\n`);
  console.log(`  ${pad('CARD COMPANY', 46)} ${pad('MATCHED HOLDER', 32)} ${pad('BOOTH', 8)} MOL`);

  const rows = [];
  let tied = 0;
  for (const c of CARDS) {
    const norm = normalizeCompany(c.company);
    const core = companyCore(c.company);
    const m = byNorm.get(norm) || (core ? byCore.get(core) : null) || null;
    if (m) tied += 1;
    rows.push({ ...c, match: m, company_normalized: norm });
    console.log(`  ${pad(c.company, 46)} ${pad(m ? m.holder : '— no DMF-holder match —', 32)} `
      + `${pad(m && m.booth ? m.booth : '—', 8)} ${m ? m.molecules_covered : ''}`);
  }

  const flagged = rows.filter(r => /CHECK|CONFIRM|VERIFY|UNKNOWN|MISSING|INCOMPLETE/.test(r.note || ''));
  console.log(`\n  tied to a booth ${tied} · standalone ${CARDS.length - tied}`);
  console.log('  A standalone card is NOT an error: a CDMO, a distributor or a peptide house holds no DMF.');
  if (flagged.length) {
    console.log(`\n  ${flagged.length} row(s) need a human before they are used:`);
    for (const f of flagged) console.log(`    ${pad(f.name, 28)} ${f.company}`);
  }
  console.log('');

  if (!WRITE) {
    console.log('── dry run ─────────────────────────────────────────────────────────────────');
    console.log(`  Nothing written. Re-run with --write to insert ${CARDS.length} contacts.\n`);
    process.exit(0);
  }

  let inserted = 0, updated = 0;
  for (const r of rows) {
    const res = await query(
      `INSERT INTO cphi_exhibitor_contacts
         (event_slug, exhibitor_match_id, company, company_normalized, name, title, email,
          phone_mobile, phone_office, website, address, source, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (event_slug, company_normalized, lower(name)) DO UPDATE
          SET exhibitor_match_id = COALESCE(EXCLUDED.exhibitor_match_id, cphi_exhibitor_contacts.exhibitor_match_id),
              title = EXCLUDED.title, email = EXCLUDED.email,
              phone_mobile = EXCLUDED.phone_mobile, phone_office = EXCLUDED.phone_office,
              website = EXCLUDED.website, address = EXCLUDED.address,
              note = EXCLUDED.note, updated_at = NOW()
       RETURNING (xmax = 0) AS was_insert`,
      [EVENT, r.match ? r.match.id : null, r.company, r.company_normalized, r.name, r.title || null,
       r.email || null, r.mobile || null, r.office || null, r.website || null, r.address || null,
       r.source || 'card', r.note || null]);
    if (res.rows[0] && res.rows[0].was_insert) inserted += 1; else updated += 1;
  }

  // Mark the companies as met, the same way day 1 does, so the floor list shows a tick against
  // every booth actually walked rather than only the ones imported first.
  const ids = [...new Set(rows.filter(r => r.match).map(r => r.match.id))];
  if (ids.length) {
    await query(
      `UPDATE cphi_exhibitor_matches
          SET met_in_person = TRUE, met_at = COALESCE(met_at, NOW())
        WHERE id = ANY($1)`, [ids]);
  }

  console.log(`✅ ${inserted} inserted, ${updated} updated, ${ids.length} booth(s) marked met.\n`);
  process.exit(0);
}

main().catch(e => { console.error('day-2 contact seed failed:', e.message); process.exit(1); });
