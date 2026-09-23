from io import BytesIO

import pytest
from openpyxl import load_workbook

from fertiliser_app import db
from fertiliser_app.app import create_app


@pytest.fixture
def app(tmp_path):
    return create_app({"DATABASE": str(tmp_path / "t.db"), "ADMIN_PIN": "", "TESTING": True})


@pytest.fixture
def client(app):
    return app.test_client()


def conn(app):
    return db.connect(app.config["DATABASE"])


def add_fert(client, name="MAP", kg="25", cost="500"):
    return client.post("/fertilisers", data={"name": name, "kg_per_bag": kg, "cost_per_bag": cost})


def stock(app, fid=1):
    return db.get_fertiliser(conn(app), fid)["stock_bags"]


def test_full_flow(app, client):
    assert add_fert(client).status_code == 302
    client.post("/deliver", data={"fertiliser_id": 1, "bags": "40", "cost_per_bag": "500",
                                  "recorded_by": "Boss"})
    r = client.post("/use", data={"fertiliser_id": 1, "bags": "3", "recorded_by": "Sipho"})
    assert r.status_code == 302 and "recorder=Sipho" in r.headers["Set-Cookie"]
    client.post("/use", data={"fertiliser_id": 1, "bags": "1.5", "recorded_by": "Sipho"})
    assert stock(app) == 35.5
    page = client.get("/").get_data(as_text=True)
    assert "35.5" in page and "MAP" in page

    # Manual stock count sets stock to the counted figure.
    client.post("/adjust", data={"fertiliser_id": 1, "counted": "34", "note": "count",
                                 "recorded_by": "Boss"})
    assert stock(app) == 34
    moves = db.query_movements(conn(app))
    assert [m["kind"] for m in moves] == ["adjustment", "usage", "usage", "delivery"]
    assert moves[0]["bags"] == -1.5
    assert all(m["created_at"] for m in moves)


def test_usage_validation(app, client):
    add_fert(client)
    assert client.post("/use", data={"fertiliser_id": 1, "bags": "0", "recorded_by": "x"}).status_code == 400
    assert client.post("/use", data={"fertiliser_id": 1, "bags": "abc", "recorded_by": "x"}).status_code == 400
    assert client.post("/use", data={"fertiliser_id": 1, "bags": "1", "recorded_by": ""}).status_code == 400
    assert client.post("/use", data={"fertiliser_id": 9, "bags": "1", "recorded_by": "x"}).status_code == 400
    assert stock(app) == 0


def test_void_excluded_from_stock(app, client):
    add_fert(client)
    client.post("/deliver", data={"fertiliser_id": 1, "bags": "10", "cost_per_bag": "500", "recorded_by": "B"})
    client.post("/use", data={"fertiliser_id": 1, "bags": "4", "recorded_by": "S"})
    client.post("/movements/2/void", data={"reason": "typo"})
    assert stock(app) == 10
    assert "typo" in client.get("/log").get_data(as_text=True)


def test_price_change_and_monthly_report(app, client):
    add_fert(client, cost="500")
    add_fert(client, name="Urea", kg="50", cost="800")
    client.post("/deliver", data={"fertiliser_id": 1, "bags": "10", "cost_per_bag": "600",
                                  "update_price": "1", "recorded_by": "B"})
    client.post("/use", data={"fertiliser_id": 1, "bags": "2", "recorded_by": "S"})
    c = conn(app)
    assert db.get_fertiliser(c, 1)["cost_per_bag"] == 600

    from datetime import date
    month = date.today().strftime("%Y-%m")
    r = client.get(f"/reports/monthly.xlsx?month={month}")
    assert r.status_code == 200
    wb = load_workbook(BytesIO(r.data))
    assert wb.sheetnames == ["Summary", "All movements", "Usage log"]
    ws = wb["Summary"]
    row = [c.value for c in ws[5]]
    assert row[0] == "MAP"
    assert row[3] == 10 and row[5] == 2 and row[6] == 50 and row[7] == 1200
    assert row[9] == 8 and row[12] == 4800
    assert wb["Usage log"].max_row == 2

    # Previous month: nothing moved, opening/closing zero.
    s = db.period_summary(c, "2000-01-01 00:00:00", "2000-02-01 00:00:00")
    assert all(r["closing_bags"] == 0 for r in s)


def test_log_excel(client):
    add_fert(client)
    client.post("/use", data={"fertiliser_id": 1, "bags": "2", "recorded_by": "S"})
    r = client.get("/log.xlsx?kind=usage")
    wb = load_workbook(BytesIO(r.data))
    assert wb.active.max_row == 2
    assert wb.active["H2"].value == "S"


def test_admin_pin(tmp_path):
    app = create_app({"DATABASE": str(tmp_path / "t.db"), "ADMIN_PIN": "4321"})
    c = app.test_client()
    # Mixer can see stock and record usage, but not manager pages.
    assert c.get("/").status_code == 200
    assert c.get("/use").status_code == 200
    for url in ("/deliver", "/adjust", "/fertilisers", "/reports", "/backup"):
        assert c.get(url).status_code == 302
    c.post("/login", data={"pin": "0000"})
    assert c.get("/deliver").status_code == 302
    c.post("/login", data={"pin": "4321"})
    assert c.get("/deliver").status_code == 200
    assert c.get("/backup").status_code == 200


def test_duplicate_name(client):
    add_fert(client)
    assert add_fert(client, name="map").status_code == 400
