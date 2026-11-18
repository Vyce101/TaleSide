"""Start or reopen TaleSide from the local launcher."""

import json
import os
import webbrowser
from pathlib import Path
from urllib.request import urlopen

from .embeddings import Gemini
from .server import INSTANCE, INSTANCE_PATH, Server
from .worlds import Worlds

PORT = 8765
DATA_DIRECTORY = Path(__file__).resolve().parent.parent / "data"


def open_running_app(port):
    url = f"http://127.0.0.1:{port}"
    try:
        with urlopen(url + INSTANCE_PATH, timeout=1) as response:
            identified = json.loads(response.read(256)) == INSTANCE
    except (OSError, ValueError):
        return False
    if not identified:
        return False
    print(f"TaleSide is already running at {url}. Opening it in your browser.", flush=True)
    webbrowser.open(url)
    return True


def main():
    try:
        server = Server(None, port=PORT)
    except OSError as error:
        if open_running_app(PORT):
            return
        raise SystemExit(
            f"Could not start TaleSide on port {PORT}. If an older TaleSide launcher is open, "
            f"close that window and try again. ({error})"
        ) from None
    with server:
        DATA_DIRECTORY.mkdir(exist_ok=True)
        worlds = Worlds(DATA_DIRECTORY / "worlds.sqlite3", Gemini(os.environ.get("GEMINI_API_KEY")))
        server.worlds = worlds
        try:
            print(f"TaleSide is running at {server.url}. Close this launcher window to stop it.", flush=True)
            webbrowser.open(server.url)
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            worlds.close()


if __name__ == "__main__":
    main()
