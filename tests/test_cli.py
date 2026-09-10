import subprocess
import sys


def test_empty_file_is_not_restored_as_a_successful_empty_catalog(tmp_path):
    source = tmp_path / "not-a-snapshot.sqlite3"
    source.touch()
    destination = tmp_path / "recovered.sqlite3"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "autodom",
            "restore",
            str(source),
            "--destination",
            str(destination),
        ],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode != 0
    assert not destination.exists()
    assert source.stat().st_size == 0
