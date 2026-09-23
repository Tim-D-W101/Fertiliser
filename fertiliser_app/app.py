"""Fertiliser stock control - a small web app for the tower server.

Staff open it in a web browser (tablet, phone or PC). The mixer records bags
used; the manager adds fertilisers, books in deliveries, corrects stock and
downloads Excel reports.
"""
import os
import secrets
import sqlite3
import tempfile
from datetime import date, datetime, timedelta
from functools import wraps

from flask import (
    Flask, abort, flash, g, redirect, render_template, request, send_file, session, url_for,
)

from . import db, reports

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def create_app(test_config=None):
    app = Flask(__name__)
    data_dir = os.environ.get("FERT_DATA_DIR", os.path.join(BASE_DIR, "data"))
    app.config.update(
        DATA_DIR=data_dir,
        DATABASE=os.path.join(data_dir, "fertiliser.db"),
        ADMIN_PIN=os.environ.get("FERT_ADMIN_PIN", ""),
        CURRENCY=os.environ.get("FERT_CURRENCY", "R"),
        SITE_NAME=os.environ.get("FERT_SITE_NAME", "Fertiliser Stock"),
    )
    if test_config:
        app.config.update(test_config)

    os.makedirs(os.path.dirname(app.config["DATABASE"]), exist_ok=True)
    app.config["SECRET_KEY"] = app.config.get("SECRET_KEY") or _secret_key(
        os.path.dirname(app.config["DATABASE"])
    )
    # Remember the manager login for 12 hours.
    app.permanent_session_lifetime = timedelta(hours=12)

    with app.app_context():
        db.init_db(get_db())
        close_db()

    app.teardown_appcontext(close_db)
    _register_helpers(app)
    _register_routes(app)
    return app


def _secret_key(data_dir):
    path = os.path.join(data_dir, "secret.key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


def get_db():
    if "db" not in g:
        from flask import current_app
        g.db = db.connect(current_app.config["DATABASE"])
    return g.db


def close_db(exc=None):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


# ------------------------------------------------------------------- helpers

def is_admin():
    from flask import current_app
    return not current_app.config["ADMIN_PIN"] or session.get("admin") is True


def admin_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not is_admin():
            flash("That page needs the manager PIN.", "error")
            return redirect(url_for("login", next=request.full_path))
        return view(*args, **kwargs)
    return wrapper


def parse_number(value, label, minimum=None, allow_zero=True):
    try:
        n = float(str(value).replace(",", ".").strip())
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a number.")
    if n != n or n in (float("inf"), float("-inf")):
        raise ValueError(f"{label} must be a number.")
    if minimum is not None and n < minimum:
        raise ValueError(f"{label} cannot be less than {minimum:g}.")
    if not allow_zero and n == 0:
        raise ValueError(f"{label} must be more than 0.")
    return n


def required_text(value, label):
    value = (value or "").strip()
    if not value:
        raise ValueError(f"Please enter {label}.")
    return value[:200]


def month_bounds(month_str):
    """'2026-09' -> ('2026-09-01 00:00:00', '2026-10-01 00:00:00', date(2026, 9, 1))"""
    first = datetime.strptime(month_str, "%Y-%m").date()
    nxt = date(first.year + (first.month == 12), first.month % 12 + 1, 1)
    return f"{first} 00:00:00", f"{nxt} 00:00:00", first


def fmt_qty(n):
    if n is None:
        return ""
    return f"{n:,.2f}".rstrip("0").rstrip(".") if n != int(n) else f"{int(n):,}"


def _register_helpers(app):
    app.jinja_env.filters["qty"] = fmt_qty

    @app.template_filter("money")
    def money(n):
        sign = "-" if n < 0 else ""
        return f"{sign}{app.config['CURRENCY']} {abs(n):,.2f}".strip()

    @app.context_processor
    def inject():
        return {
            "is_admin": is_admin(),
            "pin_enabled": bool(app.config["ADMIN_PIN"]),
            "site_name": app.config["SITE_NAME"],
            "currency": app.config["CURRENCY"],
            "kind_labels": reports.KIND_LABELS,
        }


def _remember_name(response, name):
    response.set_cookie("recorder", name, max_age=60 * 60 * 24 * 365, samesite="Lax")
    return response


# -------------------------------------------------------------------- routes

def _register_routes(app):

    @app.route("/")
    def stock():
        ferts = db.list_fertilisers(get_db())
        total_value = sum(f["stock_bags"] * f["cost_per_bag"] for f in ferts)
        return render_template("stock.html", ferts=ferts, total_value=total_value)

    # ---- usage (the mixer's screen)
    @app.route("/use", methods=["GET", "POST"])
    def use():
        conn = get_db()
        ferts = db.list_fertilisers(conn)
        if request.method == "POST":
            try:
                fid = int(request.form.get("fertiliser_id") or 0)
                fert = db.get_fertiliser(conn, fid)
                if fert is None or not fert["active"]:
                    raise ValueError("Please choose a fertiliser.")
                bags = parse_number(request.form.get("bags"), "Bags used", 0, allow_zero=False)
                name = required_text(request.form.get("recorded_by"), "your name")
                note = (request.form.get("note") or "").strip()[:500]
            except ValueError as e:
                flash(str(e), "error")
                return render_template("use.html", ferts=ferts, form=request.form,
                                       names=db.known_names(conn)), 400
            db.record_movement(conn, fid, "usage", -bags, name, note)
            left = fert["stock_bags"] - bags
            flash(f"Recorded: {fmt_qty(bags)} bag(s) of {fert['name']} used. "
                  f"{fmt_qty(left)} bag(s) left.", "ok")
            if left < 0:
                flash(f"Stock for {fert['name']} is now below zero - please tell the manager "
                      "so the stock can be checked.", "error")
            return _remember_name(redirect(url_for("use")), name)
        return render_template("use.html", ferts=ferts,
                               form={"recorded_by": request.cookies.get("recorder", "")},
                               names=db.known_names(conn))

    # ---- deliveries
    @app.route("/deliver", methods=["GET", "POST"])
    @admin_required
    def deliver():
        conn = get_db()
        ferts = db.list_fertilisers(conn)
        if request.method == "POST":
            try:
                fid = int(request.form.get("fertiliser_id") or 0)
                fert = db.get_fertiliser(conn, fid)
                if fert is None:
                    raise ValueError("Please choose a fertiliser.")
                bags = parse_number(request.form.get("bags"), "Bags delivered", 0, allow_zero=False)
                cost = parse_number(request.form.get("cost_per_bag"), "Cost per bag", 0)
                name = required_text(request.form.get("recorded_by"), "your name")
                note = (request.form.get("note") or "").strip()[:500]
            except ValueError as e:
                flash(str(e), "error")
                return render_template("deliver.html", ferts=ferts, form=request.form), 400
            if request.form.get("update_price"):
                db.set_price(conn, fid, cost, name)
            db.record_movement(conn, fid, "delivery", bags, name, note, cost_per_bag=cost)
            flash(f"Delivery booked in: {fmt_qty(bags)} bag(s) of {fert['name']}.", "ok")
            return _remember_name(redirect(url_for("stock")), name)
        return render_template("deliver.html", ferts=ferts, form={
            "recorded_by": request.cookies.get("recorder", ""),
            "update_price": "1",
            "fertiliser_id": request.args.get("fertiliser_id", ""),
        })

    # ---- manual stock correction
    @app.route("/adjust", methods=["GET", "POST"])
    @admin_required
    def adjust():
        conn = get_db()
        ferts = db.list_fertilisers(conn)
        if request.method == "POST":
            try:
                fid = int(request.form.get("fertiliser_id") or 0)
                fert = db.get_fertiliser(conn, fid)
                if fert is None:
                    raise ValueError("Please choose a fertiliser.")
                counted = parse_number(request.form.get("counted"), "Bags counted", 0)
                name = required_text(request.form.get("recorded_by"), "your name")
                reason = required_text(request.form.get("note"), "a reason for the change")
            except ValueError as e:
                flash(str(e), "error")
                return render_template("adjust.html", ferts=ferts, form=request.form), 400
            diff = round(counted - fert["stock_bags"], 4)
            if diff == 0:
                flash(f"{fert['name']} already shows {fmt_qty(counted)} bag(s) - nothing changed.", "ok")
            else:
                db.record_movement(
                    conn, fid, "adjustment", diff, name,
                    f"{reason} (was {fmt_qty(fert['stock_bags'])}, counted {fmt_qty(counted)})",
                )
                flash(f"{fert['name']} stock set to {fmt_qty(counted)} bag(s) "
                      f"({'+' if diff > 0 else ''}{fmt_qty(diff)}).", "ok")
            return _remember_name(redirect(url_for("stock")), name)
        return render_template("adjust.html", ferts=ferts, form={
            "recorded_by": request.cookies.get("recorder", ""),
            "fertiliser_id": request.args.get("fertiliser_id", ""),
        })

    # ---- fertiliser list / add / edit
    @app.route("/fertilisers", methods=["GET", "POST"])
    @admin_required
    def fertilisers():
        conn = get_db()
        form = {"kg_per_bag": "25", "reorder_level": "0"}
        status = 200
        if request.method == "POST":
            form = request.form
            try:
                name = required_text(form.get("name"), "the fertiliser name")
                kg = parse_number(form.get("kg_per_bag"), "Kg per bag", 0, allow_zero=False)
                cost = parse_number(form.get("cost_per_bag"), "Cost per bag", 0)
                reorder = parse_number(form.get("reorder_level") or 0, "Re-order level", 0)
                db.add_fertiliser(conn, name, kg, cost, reorder,
                                  request.cookies.get("recorder") or "manager")
                flash(f"Added {name}.", "ok")
                return redirect(url_for("fertilisers"))
            except ValueError as e:
                flash(str(e), "error")
                status = 400
            except sqlite3.IntegrityError:
                flash("A fertiliser with that name already exists.", "error")
                status = 400
        return render_template(
            "fertilisers.html", ferts=db.list_fertilisers(conn, include_inactive=True), form=form
        ), status

    @app.route("/fertilisers/<int:fid>", methods=["GET", "POST"])
    @admin_required
    def edit_fertiliser(fid):
        conn = get_db()
        fert = db.get_fertiliser(conn, fid)
        if fert is None:
            abort(404)
        form = fert
        if request.method == "POST":
            form = request.form
            try:
                name = required_text(form.get("name"), "the fertiliser name")
                kg = parse_number(form.get("kg_per_bag"), "Kg per bag", 0, allow_zero=False)
                cost = parse_number(form.get("cost_per_bag"), "Cost per bag", 0)
                reorder = parse_number(form.get("reorder_level") or 0, "Re-order level", 0)
                db.update_fertiliser(conn, fid, name, kg, cost, reorder, bool(form.get("active")),
                                     request.cookies.get("recorder") or "manager")
                flash(f"Saved {name}.", "ok")
                return redirect(url_for("fertilisers"))
            except ValueError as e:
                flash(str(e), "error")
            except sqlite3.IntegrityError:
                flash("A fertiliser with that name already exists.", "error")
        prices = conn.execute(
            "SELECT * FROM price_history WHERE fertiliser_id = ? ORDER BY changed_at DESC, id DESC",
            (fid,),
        ).fetchall()
        return render_template("edit_fertiliser.html", fert=fert, form=form, prices=prices)

    # ---- log
    def _log_filters():
        args = request.args
        today = date.today()
        start = args.get("start") or (today - timedelta(days=30)).isoformat()
        end = args.get("end") or today.isoformat()
        try:
            start_d = date.fromisoformat(start)
            end_d = date.fromisoformat(end)
        except ValueError:
            abort(400)
        fid = int(args["fertiliser_id"]) if args.get("fertiliser_id", "").isdigit() else None
        kind = args.get("kind") if args.get("kind") in reports.KIND_LABELS else None
        return {
            "start": start_d.isoformat(), "end": end_d.isoformat(),
            "fertiliser_id": fid, "kind": kind,
        }

    def _log_rows(f):
        end_excl = (date.fromisoformat(f["end"]) + timedelta(days=1)).isoformat()
        return db.query_movements(get_db(), f"{f['start']} 00:00:00", f"{end_excl} 00:00:00",
                                  f["fertiliser_id"], f["kind"])

    @app.route("/log")
    def log():
        f = _log_filters()
        return render_template("log.html", rows=_log_rows(f), f=f,
                               ferts=db.list_fertilisers(get_db(), include_inactive=True))

    @app.route("/log.xlsx")
    def log_xlsx():
        f = _log_filters()
        rows = list(reversed(_log_rows(f)))
        buf = reports.movements_report(rows, app.config["CURRENCY"])
        return send_file(buf, mimetype=XLSX, as_attachment=True,
                         download_name=f"fertiliser-log-{f['start']}-to-{f['end']}.xlsx")

    @app.route("/movements/<int:mid>/void", methods=["POST"])
    @admin_required
    def void(mid):
        reason = (request.form.get("reason") or "").strip()
        name = (request.form.get("recorded_by") or request.cookies.get("recorder") or "manager").strip()
        if not reason:
            flash("Please give a reason for cancelling the entry.", "error")
        else:
            db.void_movement(get_db(), mid, name, reason[:200])
            flash("Entry cancelled. It stays in the log crossed out and no longer counts.", "ok")
        return redirect(request.form.get("back") or url_for("log"))

    # ---- reports
    @app.route("/reports")
    @admin_required
    def reports_page():
        month = request.args.get("month") or date.today().strftime("%Y-%m")
        try:
            start, end, first = month_bounds(month)
        except ValueError:
            abort(400)
        summary = db.period_summary(get_db(), start, end)
        return render_template("reports.html", month=month, first=first, summary=summary)

    @app.route("/reports/monthly.xlsx")
    @admin_required
    def monthly_xlsx():
        month = request.args.get("month") or date.today().strftime("%Y-%m")
        try:
            start, end, first = month_bounds(month)
        except ValueError:
            abort(400)
        conn = get_db()
        summary = db.period_summary(conn, start, end)
        movements = list(reversed(db.query_movements(conn, start, end)))
        title = f"{app.config['SITE_NAME']} - fertiliser report for {first:%B %Y}"
        buf = reports.monthly_report(summary, movements, title, app.config["CURRENCY"])
        return send_file(buf, mimetype=XLSX, as_attachment=True,
                         download_name=f"fertiliser-report-{month}.xlsx")

    @app.route("/backup")
    @admin_required
    def backup():
        """Download a consistent copy of the whole database."""
        tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        tmp.close()
        dest = sqlite3.connect(tmp.name)
        get_db().backup(dest)
        dest.close()
        with open(tmp.name, "rb") as fh:
            data = fh.read()
        os.unlink(tmp.name)
        from io import BytesIO
        return send_file(BytesIO(data), mimetype="application/octet-stream", as_attachment=True,
                         download_name=f"fertiliser-backup-{datetime.now():%Y%m%d-%H%M}.db")

    # ---- manager login
    @app.route("/login", methods=["GET", "POST"])
    def login():
        nxt = request.values.get("next") or url_for("stock")
        if not nxt.startswith("/") or nxt.startswith("//"):
            nxt = url_for("stock")
        if request.method == "POST":
            if app.config["ADMIN_PIN"] and secrets.compare_digest(
                request.form.get("pin", ""), app.config["ADMIN_PIN"]
            ):
                session.permanent = True
                session["admin"] = True
                flash("Manager mode on.", "ok")
                return redirect(nxt)
            flash("Wrong PIN.", "error")
        return render_template("login.html", next=nxt)

    @app.route("/logout", methods=["POST"])
    def logout():
        session.pop("admin", None)
        flash("Manager mode off.", "ok")
        return redirect(url_for("stock"))
