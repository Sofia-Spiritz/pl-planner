# P&L Planner

Order-by-order profit and loss in one place: revenue after tax, COGS, pick & pack, shipping and payment fees per order, then marketing and OPEX down to net profit. Viewed by day, week or month, and by market, 3PL and product collection, with every cost shown as a share of net revenue.

**Status: framework on sample data.** The page, the database tables and the reporting are in place. No real client data is loaded yet; every number shown is invented and labelled as sample data.

## What is in this folder

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The dashboard: one web page with a sign-in screen and eight tabs |
| `config.js` | Address and public key of the Sofia & Spiritz Supabase project (the public key is safe to share; the secret key never goes in this folder) |
| `sql/001_schema.sql` | Creates the tables, the security rules and the reporting function |
| `sql/002_sample_data.sql` | Fills the tables with about 180 days of invented orders |
| `sql/003_clear_sample_data.sql` | Removes the invented rows before real data goes in |

## Seeing it

Open https://sofia-spiritz.github.io/pl-planner/ (hosted on GitHub Pages from the `main` branch) and choose **Open the demo with sample data**. The demo makes its numbers in the browser and reads nothing from the database.

## Connecting the database (one-off)

In the **Sofia & Spiritz** Supabase project:

1. SQL editor: paste and run `sql/001_schema.sql`.
2. SQL editor: paste and run `sql/002_sample_data.sql`.
3. Authentication > Users > Add user: create a sign-in for each person who should see the dashboard.
4. SQL editor: add the same email to the allowed list, `insert into public.dashboard_users (email) values ('name@example.com');`
5. Authentication > Sign In / Providers: turn off "Allow new users to sign up".

Then sign in on the page with that email and password. Only signed-in users on the allowed list can read the data, and nobody can change data from the web page.

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
