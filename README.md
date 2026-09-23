# Fertiliser Stock

A small web app for tracking fertiliser stock: what comes in, what the mixer
uses, what is left, and what it cost. It runs on the tower server and
people use it from a web browser on a tablet, phone or PC. There is nothing to
install on the tablet.

## What it does

| Who | Page | What it's for |
|---|---|---|
| Everyone | **Stock** | Current bags, kg and value of each fertiliser. Low stock shows orange, below zero shows red |
| Mixer | **Use bags** | Pick the fertiliser, enter the number of bags, enter your name, then Save. Half bags are allowed |
| Everyone | **Log** | Every movement with its date and time, filtered by date, fertiliser and type. Has a **Download Excel** button |
| Manager | **Delivery** | Book in bags received and the cost per bag. This can also update the price |
| Manager | **Stock count** | Enter the bags counted in the store. The app saves the difference as an adjustment, with a reason |
| Manager | **Fertilisers** | Add or edit fertilisers (name, kg per bag, cost per bag, re-order level). Shows the price history |
| Manager | **Reports** | Monthly Excel report with opening stock, received, used (bags, kg and cost), adjustments, closing stock and its value. Also has a database backup download |

Every entry is saved with a timestamp and the name of the person who made
it. Entries are never deleted. The manager can **cancel** an entry that was
a mistake: it stays in the log crossed out, with who cancelled it and why,
and it no longer counts towards stock.

Costs are saved with each entry, so a price change does not alter old
months. Closing stock is valued at the price in force at the end of the month.

## Setting it up on the tower server (Windows)

1. Install Python 3 from <https://www.python.org/downloads/>. On the first
   installer screen, tick **"Add python.exe to PATH"**.
2. Copy this folder onto the server, for example `C:\FertiliserStock`.
3. Open `start_server.bat` in Notepad and set:
   - `FERT_ADMIN_PIN`: the manager PIN. The mixer can only see stock, record
     usage and view the log without it.
   - `FERT_CURRENCY`: the currency label shown on costs (default `R`).
4. Double-click `start_server.bat`. The first run installs what it needs,
   which takes about a minute. The window then shows an address like
   `http://192.168.1.20:8080`.
5. On the tablet, open that address in Chrome or Safari. Use **Add to Home
   screen** so it opens like an app.

If Windows Firewall asks, allow Python on **private networks**. To start the
app automatically, put a shortcut to `start_server.bat` in the server's
Startup folder (press Win+R, type `shell:startup`) or add it to Task
Scheduler with the trigger "At startup".

All data is stored in one file, `data\fertiliser.db`. Include the `data`
folder in the server's normal backups. You can also download a copy from
**Reports → Download a full backup**.

### Linux server

```
python3 -m venv venv && venv/bin/pip install -r requirements.txt
FERT_ADMIN_PIN=1234 venv/bin/python run_server.py 8080
```

## Access over the internet

The simplest and safest option is **Tailscale** (free for small use):

1. Install Tailscale on the tower server and on each tablet, phone or laptop
   that needs access, and sign in with the same account.
2. Open `http://<server's Tailscale name or IP>:8080` from anywhere.

You don't need to change the router, and the app is never exposed to the
public internet.

If you port-forward the router to the server instead, put it behind HTTPS
(for example a reverse proxy such as Caddy) and set a manager PIN. Staff
pages (stock, usage, log) have no password, so a public address without
extra protection is not recommended.

## Running on just one tablet

The app needs a computer to run on. If the server isn't available yet, run
it on any Windows PC or laptop on the same Wi-Fi as the tablet, following the
same steps. Move it to the server later by copying the whole folder,
including `data\`.

## Development

```
pip install -r requirements.txt pytest
python -m pytest
```
