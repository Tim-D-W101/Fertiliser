# Fertiliser Stock

Keeps track of fertiliser: deliveries coming in, bags the mixer takes out,
stock on hand, and a monthly Excel report of what was used, what it cost,
and what is left.

It is built the same way as **Tikita**. It installs to the home screen of a
tablet, phone or PC, works with no signal, and shares one set of records
between every device that has the company code.

**Address:** <https://tim-d-w101.github.io/Fertiliser/>

---

## Using it day to day

**Stock** shows each fertiliser in bags and kg. A card turns orange when it
is down to its re-order level and red if it has gone below zero, which means
it is time for a stock count. The manager also sees what the stock is worth.

**Use bags** is the mixer's screen. Tap the fertiliser, set the number of
bags with − / + (half and quarter bags can be typed), check the name and tap
**Save**. The tablet remembers the name. After saving, an **Undo** button
stays up for a few seconds in case of a wrong tap. Recording works without
signal, and the entry keeps the time it was actually made.

**Log** lists every entry with its date, time and who made it. You can filter
it by dates, fertiliser and type (Delivery, Used, Stock count), and
**Export Excel file** downloads what is on screen.

To fix a wrong entry, the manager taps **Cancel** on it and gives a reason.
The entry stays in the log, crossed out, with who cancelled it and why, and
it no longer counts towards stock. Entries are never deleted.

**Book in a delivery** (from the Stock screen): choose the fertiliser, then
enter the bags and the cost per bag. The current price is filled in for you.
Tick **Make this the price from now on** if the price has changed.

**Stock count** is for correcting the stock by hand. Enter the bags actually
in the store and a reason. The difference goes into the log as a stock count.
Use it to load the opening stock when you start.

**Report** shows one month at a time: opening stock, bags received, bags and
kg used, the cost of fertiliser used, stock counts, closing stock and its
value. **Export Excel file** gives a workbook with three sheets:

| Sheet | What is on it |
|---|---|
| Summary | One row per fertiliser with the figures above, plus totals |
| All entries | Every delivery, usage and stock count in the month |
| Usage log | Only the bags taken out: when, what, how many and who |

Cancelled entries appear crossed out on the sheets but are left out of all
totals. Usage is costed at the price in force when the bags were taken.
Closing stock is valued at the price in force at the end of the month, so a
price change later does not alter an earlier month.

**Setup** has these sections:

- **Fertilisers:** add or edit the name, kg per bag, cost per bag and
  re-order level. Untick *In use* to hide one that is no longer bought; its
  history is kept.
- **Mixer lock:** set a manager PIN on the mixer's tablet. Once it is locked,
  the tablet only shows Stock, Use bags and Log, and no costs. **Manager**
  unlocks it. It locks itself again when the app is reopened, or after 15
  minutes without use. The PIN only applies to that one device.
- **Sharing:** enter the company code.

## Several devices

Tap the status chip in the top bar and enter the fertiliser company code.
It is a different code from Tikita's: the Tikita code does not open the
fertiliser records, and this code does not open Tikita. Ask whoever set the
app up for it; it is deliberately not stored in this repository. Anyone
holding it can read and change the stock records, so treat it like a key.
Every device with the code shares the same fertiliser list, stock
and log. The chip shows where things stand: *This device only*, *Synced*,
*3 waiting*, *Syncing…* or *Not synced*.

Entries are saved on the device first and sent the moment there is a
connection. Other devices' entries come down at the same time, and a device
left open on the stock screen checks every minute.

Until a device is connected, its records exist only on that device. Use
**Report → Backup → Save backup** to keep a copy.

## Hosting it

Like Tikita, the app is plain HTML, CSS and JavaScript with no build step,
published by GitHub Pages. The workflow in `.github/workflows/pages.yml`
publishes it on every push, to <https://tim-d-w101.github.io/Fertiliser/>.

Pages has to be switched on once by hand, because a workflow is not allowed
to switch it on for itself: *Settings → Pages → Build and deployment →
Source:* **GitHub Actions**. Then re-run the latest workflow from the
**Actions** tab. Until that is done, the workflow fails at "Create Pages
site"; that is expected and is not a problem with the app.

### Installing it

Open the address on the tablet once, with signal, so the app can save itself
for offline use.

- **Android / Chrome:** tap **Install** in the top bar, or use the ⋮ menu →
  *Add to Home screen*.
- **iPad / iPhone:** in Safari, tap Share → *Add to Home Screen*.
- **PC:** open the address in Edge, then **… → Apps → Install this site as
  an app**.

Then tap the status chip and enter the fertiliser company code. A change
pushed here reaches every device the next time the app is opened, with no
reinstall. Records are never touched by an update.

To try it locally:

```sh
python3 -m http.server 8000     # then open http://localhost:8000
```

## How it is put together

| File | What it does |
|---|---|
| `index.html` | The page shell; each screen is drawn by `app.js` |
| `app.js` | State, storage, screens, the monthly figures and the Excel layout |
| `xlsx.js` | A small `.xlsx` writer (no library), extended from Tikita's to write several sheets |
| `sync.js` | Talks to the shared database and queues changes made offline |
| `sw.js` | Service worker that caches the app for offline use |
| `manifest.webmanifest` | Makes it installable |
| `supabase/fertiliser.sql` | The database tables and functions |

Data is kept in `localStorage` under `fertiliser.v1`:

```js
{
  products: [{ id, name, kg, cost, reorder, active }],
  moves:    [{ id, pid, kind, bags, kg, cost, by, note, at, voidAt, voidBy, voidReason }],
  prices:   [{ id, pid, cost, at, by }],
  sync, pending
}
```

- `kind` is `delivery`, `usage` or `adjustment`.
- `bags` is the signed change in stock (+ in, − out).
- `kg` and `cost` are copied onto each entry when it is made.

Stock is never stored as a number. It is the sum of every entry that has not
been cancelled. The name and PIN set on a device are kept separately under
`fertiliser.device`; they are never synced and never included in a backup.

### The shared database

It lives in the same Supabase project as Tikita, with its own company codes
in `fert_workspaces`. Tikita's tables and functions are untouched. To move to
a fresh code, change `join_code` in `fert_workspaces` and enter the new code
on each device. As with Tikita, the tables cannot be reached
through the API. All access goes through three functions that check the code
first:

| Function | Does |
|---|---|
| `fert_join(code)` | Confirms a code and returns the company name |
| `fert_pull(code, since)` | Everything changed since that moment |
| `fert_push(code, payload)` | Saves this device's changes, stamped by the server |

Once saved, an entry's figures never change. The server only ever adds a
cancellation to an entry, and never removes one.
