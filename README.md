# P&L Planner

Order-by-order profit and loss in one place: revenue after tax, COGS, pick & pack, shipping and payment fees per order, then marketing and OPEX down to net profit. Viewed by day, week or month, and by market, 3PL and product collection, with every cost shown as a share of net revenue.

**Status: framework on sample data.** The page, the database tables and the reporting are in place. No real client data is loaded yet; every number shown is invented and labelled as sample data.

## What is in this folder

| File | What it is |
|---|---|
| `web/` | The dashboard's source (React, shadcn/ui, Evil Charts). Change it here, then run `node scripts/build-web.mjs` |
| `index.html`, `assets/` | The built dashboard that GitHub Pages serves. Made by the build, not edited by hand |
| `classic/` | The earlier plain-HTML dashboard, kept at `/pl-planner/classic/`. Its `config.js` holds the address and public key of the Sofia & Spiritz Supabase project (the public key is safe to share; the secret key never goes in this folder) |
| `next/` | A redirect only. It was the preview address of the React dashboard before it became the main one |
| `supabase/migrations/` | Database changes, in order. The first one creates the tables, the security rules and the reporting function |
| `supabase/seeds/01_sample_data.sql` | Fills the tables with about 180 days of invented orders |
| `supabase/seeds/00_private_users.sql` | The emails allowed to see the data. Kept on the PC only, never committed |
| `sql/003_clear_sample_data.sql` | Removes the invented rows before real data goes in |

## Seeing it

Open https://sofia-spiritz.github.io/pl-planner/ (hosted on GitHub Pages from the `main` branch) and choose **Open the demo with sample data**. The demo makes its numbers in the browser and reads nothing from the database.

## Connecting the database (one-off)

The tables and sample data are applied from this folder with the Supabase command-line tool, signed in to the **Sofia & Spiritz** account:

    npx supabase db push --remote --include-seed

In the Supabase dashboard, for each person who should see the data:

1. Authentication > Users > Add user: create their sign-in.
2. Add the same email to `supabase/seeds/00_private_users.sql` and run the command above again.
3. Authentication > Sign In / Providers: turn off "Allow new users to sign up".

Then sign in on the page with that email and password. Only signed-in users on the allowed list can read the data, and nobody can change data from the web page.

## Live Google Sheets (receiving side)

The database can pull Google Sheet tabs into itself every 15 minutes:

- `sheet_sources` lists the tabs to read; `sheet_rows` holds a copy of each tab's rows; `sheet_sync_log` records every run.
- The `sync-sheets` function (in `supabase/functions/`) does the reading, through a read-only Google service account. Each sheet must be shared as Viewer with that account's email.
- The service account key is stored as the Supabase secret `GOOGLE_SERVICE_ACCOUNT`. It is never kept in this repo.
- The dashboard's Data notes tab shows each sheet and when it last synced.

Not done yet: the Google service account itself, listing the real sheets, and the rules that turn raw sheet rows into dashboard numbers.

## How the numbers are defined

- **Revenue**: sales after discounts and refunds, tax still included.
- **Net revenue**: revenue minus the tax for the ship-to market. All percentages are a share of net revenue.
- **Gross profit**: net revenue minus COGS, pick & pack, shipping and payment fees.
- **Contribution**: gross profit minus marketing.
- **Net profit**: contribution minus OPEX (monthly, shared evenly across the days of the month).
- Each cost on each order line is marked **actual** (invoice or payout) or **estimate** (rate card or model).

## Not built yet

- Imports of real orders, 3PL invoices, payouts, ad spend and OPEX.
- The FIFO engine for landed cost per unit (COGS is currently a stored figure per order line).
- Reconciliation against payouts and the bank; the bridge to Lifetimely and Profitably.
- Export to PowerPoint or a spreadsheet.
