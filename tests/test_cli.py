import json
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from trpg_gm.cli import main


class CliTests(unittest.TestCase):
    def test_room_create_and_context_emit_json(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / "game.sqlite3")
            with redirect_stdout(StringIO()):
                self.assertEqual(main(["--db", db, "room", "create", "demo", "--system", "coc7"]), 0)
            output = StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(["--db", db, "context", "demo"]), 0)

            self.assertEqual(json.loads(output.getvalue())["room"]["id"], "demo")


if __name__ == "__main__":
    unittest.main()
