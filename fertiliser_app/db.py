"""SQLite storage for fertilisers and stock movements.

Stock on hand is never stored directly: it is the sum of every non-voided
movement (deliveries are positive, usage is negative, adjustments either way).
That way the log is always the single source of truth.
"""
import sqlite3
from datetime import datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS fertilisers (
    id            INTEGER PRIMARY KEY,
    name          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    kg_per_bag    REAL    NOT NULL,
    cost_per_bag  REAL    NOT NULL,
    reorder_level REAL    NOT NULL DEFAULT 0,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL
);

-- Every price a fertiliser has had, so old reports are valued correctly.
CREATE TABLE IF NOT EXISTS price_history (
    id            INTEGER PRIMARY KEY,
    fertiliser_id INTEGER NOT NULL REFERENCES fertilisers(id),
    cost_per_bag  REAL    NOT NULL,
    changed_at    TEXT    NOT NULL,
    changed_by    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS movements (
    id            INTEGER PRIMARY KEY,
    fertiliser_id INTEGER NOT NULL REFERENCES fertilisers(id),
    kind          TEXT    NOT NULL CHECK (kind IN ('delivery', 'usage', 'adjustment')),
    bags          REAL    NOT NULL,  -- signed change in stock, in bags
    kg_per_bag    REAL    NOT NULL,  -- snapshot at time of movement
    cost_per_bag  REAL    NOT NULL,  -- snapshot at time of movement
    recorded_by   TEXT    NOT NULL,
    note          TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL,
    voided_at     TEXT,
    voided_by     TEXT,
    void_reason   TEXT
);

CREATE INDEX IF NOT EXISTS idx_movements_created ON movements(created_at);
CREATE INDEX IF NOT EXISTS idx_movements_fert ON movements(fertiliser_id);
"""

TS_FORMAT = "%Y-%m-%d %H:%M:%S"


def now():
    return datetime.now().strftime(TS_FORMAT)


def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(conn):
    conn.executescript(SCHEMA)
    conn.commit()


# ---------------------------------------------------------------- fertilisers

def list_fertilisers(conn, include_inactive=False):
    sql = """
        SELECT f.*,
               COALESCE((SELECT SUM(m.bags) FROM movements m
                         WHERE m.fertiliser_id = f.id AND m.voided_at IS NULL), 0) AS stock_bags
        FROM fertilisers f
    """
    if not include_inactive:
        sql += " WHERE f.active = 1"
    sql += " ORDER BY f.name COLLATE NOCASE"
    return conn.execute(sql).fetchall()


def get_fertiliser(conn, fid):
    return conn.execute(
        """SELECT f.*,
                  COALESCE((SELECT SUM(m.bags) FROM movements m
                            WHERE m.fertiliser_id = f.id AND m.voided_at IS NULL), 0) AS stock_bags
           FROM fertilisers f WHERE f.id = ?""",
        (fid,),
    ).fetchone()


def add_fertiliser(conn, name, kg_per_bag, cost_per_bag, reorder_level, user):
    ts = now()
    cur = conn.execute(
        "INSERT INTO fertilisers (name, kg_per_bag, cost_per_bag, reorder_level, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (name, kg_per_bag, cost_per_bag, reorder_level, ts),
    )
    conn.execute(
        "INSERT INTO price_history (fertiliser_id, cost_per_bag, changed_at, changed_by)"
        " VALUES (?, ?, ?, ?)",
        (cur.lastrowid, cost_per_bag, ts, user),
    )
    conn.commit()
    return cur.lastrowid


def update_fertiliser(conn, fid, name, kg_per_bag, cost_per_bag, reorder_level, active, user):
    old = get_fertiliser(conn, fid)
    conn.execute(
        "UPDATE fertilisers SET name = ?, kg_per_bag = ?, cost_per_bag = ?,"
        " reorder_level = ?, active = ? WHERE id = ?",
        (name, kg_per_bag, cost_per_bag, reorder_level, 1 if active else 0, fid),
    )
    if old is not None and old["cost_per_bag"] != cost_per_bag:
        conn.execute(
            "INSERT INTO price_history (fertiliser_id, cost_per_bag, changed_at, changed_by)"
            " VALUES (?, ?, ?, ?)",
            (fid, cost_per_bag, now(), user),
        )
    conn.commit()


def set_price(conn, fid, cost_per_bag, user):
    old = get_fertiliser(conn, fid)
    if old["cost_per_bag"] == cost_per_bag:
        return
    conn.execute("UPDATE fertilisers SET cost_per_bag = ? WHERE id = ?", (cost_per_bag, fid))
    conn.execute(
        "INSERT INTO price_history (fertiliser_id, cost_per_bag, changed_at, changed_by)"
        " VALUES (?, ?, ?, ?)",
        (fid, cost_per_bag, now(), user),
    )
    conn.commit()


def price_at(conn, fid, ts):
    """Cost per bag that applied at timestamp `ts` (falls back to the current price)."""
    row = conn.execute(
        "SELECT cost_per_bag FROM price_history WHERE fertiliser_id = ? AND changed_at <= ?"
        " ORDER BY changed_at DESC, id DESC LIMIT 1",
        (fid, ts),
    ).fetchone()
    if row:
        return row["cost_per_bag"]
    return get_fertiliser(conn, fid)["cost_per_bag"]


# ------------------------------------------------------------------ movements

def record_movement(conn, fid, kind, bags, user, note="", cost_per_bag=None):
    """Insert a movement. `bags` is the signed change in stock."""
    fert = get_fertiliser(conn, fid)
    if fert is None:
        raise ValueError("Unknown fertiliser")
    cur = conn.execute(
        "INSERT INTO movements (fertiliser_id, kind, bags, kg_per_bag, cost_per_bag,"
        " recorded_by, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            fid,
            kind,
            bags,
            fert["kg_per_bag"],
            fert["cost_per_bag"] if cost_per_bag is None else cost_per_bag,
            user,
            note,
            now(),
        ),
    )
    conn.commit()
    return cur.lastrowid


def void_movement(conn, mid, user, reason):
    conn.execute(
        "UPDATE movements SET voided_at = ?, voided_by = ?, void_reason = ?"
        " WHERE id = ? AND voided_at IS NULL",
        (now(), user, reason, mid),
    )
    conn.commit()


def query_movements(conn, start=None, end=None, fid=None, kind=None, include_voided=True):
    """Movements with created_at in [start, end) (timestamps as strings)."""
    sql = """
        SELECT m.*, f.name AS fertiliser_name
        FROM movements m JOIN fertilisers f ON f.id = m.fertiliser_id
        WHERE 1 = 1
    """
    args = []
    if start:
        sql += " AND m.created_at >= ?"
        args.append(start)
    if end:
        sql += " AND m.created_at < ?"
        args.append(end)
    if fid:
        sql += " AND m.fertiliser_id = ?"
        args.append(fid)
    if kind:
        sql += " AND m.kind = ?"
        args.append(kind)
    if not include_voided:
        sql += " AND m.voided_at IS NULL"
    sql += " ORDER BY m.created_at DESC, m.id DESC"
    return conn.execute(sql, args).fetchall()


def known_names(conn):
    rows = conn.execute(
        "SELECT recorded_by, MAX(created_at) AS last FROM movements"
        " GROUP BY recorded_by COLLATE NOCASE ORDER BY last DESC LIMIT 20"
    ).fetchall()
    return [r["recorded_by"] for r in rows]


# -------------------------------------------------------------------- reports

def period_summary(conn, start, end):
    """Per-fertiliser totals for movements in [start, end).

    Returns a list of dicts with opening/received/used/adjusted/closing bags,
    kg used, cost of fertiliser used and the value of the closing balance
    (valued at the price in force at the end of the period).
    """
    rows = []
    ferts = conn.execute(
        "SELECT * FROM fertilisers ORDER BY name COLLATE NOCASE"
    ).fetchall()
    for f in ferts:
        opening = conn.execute(
            "SELECT COALESCE(SUM(bags), 0) FROM movements"
            " WHERE fertiliser_id = ? AND voided_at IS NULL AND created_at < ?",
            (f["id"], start),
        ).fetchone()[0]
        agg = {}
        for kind in ("delivery", "usage", "adjustment"):
            agg[kind] = conn.execute(
                "SELECT COALESCE(SUM(bags), 0) AS bags,"
                "       COALESCE(SUM(bags * kg_per_bag), 0) AS kg,"
                "       COALESCE(SUM(bags * cost_per_bag), 0) AS cost"
                " FROM movements WHERE fertiliser_id = ? AND kind = ? AND voided_at IS NULL"
                " AND created_at >= ? AND created_at < ?",
                (f["id"], kind, start, end),
            ).fetchone()
        received = agg["delivery"]["bags"]
        used = -agg["usage"]["bags"]
        adjusted = agg["adjustment"]["bags"]
        closing = opening + received - used + adjusted
        # Skip retired fertilisers that had nothing going on.
        if not f["active"] and not any([opening, received, used, adjusted]):
            continue
        price = price_at(conn, f["id"], end)
        rows.append(
            {
                "name": f["name"],
                "kg_per_bag": f["kg_per_bag"],
                "opening_bags": opening,
                "received_bags": received,
                "received_cost": agg["delivery"]["cost"],
                "used_bags": used,
                "used_kg": -agg["usage"]["kg"],
                "used_cost": -agg["usage"]["cost"],
                "adjusted_bags": adjusted,
                "closing_bags": closing,
                "closing_kg": closing * f["kg_per_bag"],
                "price_per_bag": price,
                "closing_value": closing * price,
            }
        )
    return rows
