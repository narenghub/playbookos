# Abiozen PlaybookOS

AI-driven team performance and target tracking platform. Connect your team, GitHub, and revenue data. Claude analyzes progress and sends weekly reports.

---

## Quick Start (5 minutes)

### Prerequisites
- Node.js 18+ (download from nodejs.org)
- An Anthropic API key (console.anthropic.com)
- A GitHub Personal Access Token (github.com/settings/tokens)
- Gmail account for email alerts (optional but recommended)

### 1. Install dependencies
```bash
cd playbookos
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Open `.env` and fill in:
- `JWT_SECRET` — run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` to generate
- `ADMIN_EMAIL` — your email (naresh@abiozen.com)
- `ADMIN_PASSWORD` — your login password
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- `GITHUB_TOKEN` — from github.com/settings/tokens (scopes: repo, read:org, read:user)
- `SMTP_*` — Gmail credentials for email alerts

### 3. Initialize database
```bash
node scripts/setup-db.js
```

### 4. Start server
```bash
node server.js
```

Open: http://localhost:3000

Login with your ADMIN_EMAIL and ADMIN_PASSWORD from .env

---

## Deployment Options

### Option A: Railway (recommended — free, accessible by your whole team)
1. Push this folder to a GitHub repository
2. Go to railway.app → New Project → Deploy from GitHub repo
3. Add all variables from .env.example in the Railway dashboard
4. Railway auto-deploys. You get a URL like: https://playbookos-production.railway.app
5. Set `BASE_URL` in Railway env vars to that URL

### Option B: Your laptop (local only)
Just run `node server.js`. Access at http://localhost:3000 from your own browser.

### Option C: DigitalOcean/VPS ($6/month)
```bash
apt update && apt install nodejs npm git
git clone <your-repo> playbookos && cd playbookos
npm install && cp .env.example .env && nano .env
node scripts/setup-db.js
npm install -g pm2
pm2 start server.js --name playbookos
pm2 startup && pm2 save
```
Add nginx reverse proxy for HTTPS.

---

## How to Use

### 1. Invite your team
- Login as admin → Team → Invite member
- Enter their email, select their role, add GitHub username (for devs)
- They receive an email with a link to set their password

### 2. Each team member logs daily activity
- Devs: PRs merged, commits, features deployed
- Procurement: SKUs priced, COAs collected, suppliers contacted
- Sales: outreach emails, calls, demos, revenue closed
- Marketing: campaigns sent, leads, content published

### 3. GitHub auto-sync
- Runs daily at 8 AM automatically
- Or click "Sync GitHub now" in the GitHub Stats page
- Shows commits, PRs opened, PRs merged per developer per day

### 4. Log revenue
- Admin → Revenue & Orders → Add order
- Enter amount, buyer type, product category
- Revenue tracks against monthly and annual targets

### 5. AI analysis
- Admin → AI Insights → Run AI analysis now
- Claude reviews all team activity, revenue vs target, and gives 3-4 sentence assessment
- Auto-runs every Monday morning and emails the admin

### 6. Milestone triggers
- When revenue hits $100K: email fires to admin to hire Account Manager
- When $500K/month: trigger to hire Sales Rep + Marketing Manager
- All 8 milestones tracked with status updates

---

## Team Roles & What They See

| Role | Dashboard | Activity log | Playbook | GitHub | Revenue | AI Insights | Team admin |
|------|-----------|--------------|----------|--------|---------|-------------|------------|
| Admin (Naresh) | ✅ Full | ✅ | ✅ | ✅ | ✅ Enter + view | ✅ | ✅ |
| Dev | ✅ Own | ✅ | ✅ | ✅ | View only | ❌ | ❌ |
| Procurement | ✅ Own | ✅ | ✅ | ❌ | View only | ❌ | ❌ |
| Sales | ✅ Own | ✅ | ✅ | ❌ | View own | ❌ | ❌ |
| Marketing | ✅ Own | ✅ | ✅ | ❌ | View only | ❌ | ❌ |

---

## Files
```
playbookos/
├── server.js              # Main server + cron jobs
├── package.json           # Dependencies
├── .env.example           # Config template → copy to .env
├── playbookos.db          # SQLite database (auto-created)
├── scripts/
│   └── setup-db.js        # One-time database initialization
├── src/
│   ├── lib/
│   │   └── core.js        # DB, auth, GitHub, email, Claude helpers
│   └── api/
│       └── routes.js      # All REST API endpoints
└── public/
    └── index.html         # Complete frontend (single file)
```

---

## Support
Built by Claude (Anthropic) for Abiozen LLC. Questions? Ask Claude in your next conversation — reference "PlaybookOS" and paste any error messages.
