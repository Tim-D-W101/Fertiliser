"""Start the fertiliser app so other devices on the network can use it.

    python run_server.py            (listens on port 8080)
    python run_server.py 5000       (choose another port)

Settings (optional environment variables):
    FERT_ADMIN_PIN   PIN for manager pages (deliveries, stock counts, reports).
                     If not set, everyone can use every page.
    FERT_CURRENCY    Currency label shown on costs (default "R").
    FERT_SITE_NAME   Name shown at the top of the app.
    FERT_DATA_DIR    Folder for the database (default: ./data).
"""
import socket
import sys

from waitress import serve

from fertiliser_app.app import create_app


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    app = create_app()
    print(f"Fertiliser app running. Open  http://{local_ip()}:{port}  on the tablet.")
    print(f"Database: {app.config['DATABASE']}")
    print("Leave this window open. Press Ctrl+C to stop.")
    serve(app, host="0.0.0.0", port=port)
