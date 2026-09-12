"""Build-time only: fetch immutable public weights, verify every artifact."""

import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent


def main() -> None:
    manifest = json.loads((ROOT / "models.json").read_text())
    for name, model in manifest.items():
        directory = ROOT / "models" / name
        directory.mkdir(parents=True, exist_ok=True)
        for filename, expected in model["files"].items():
            target = directory / filename
            url = (
                f"https://huggingface.co/{model['repository']}/resolve/"
                f"{model['revision']}/{filename}"
            )
            with urlopen(url, timeout=120) as response, target.open("wb") as output:
                digest = hashlib.sha256() if "lfs" in expected else hashlib.sha1()
                if "lfs" not in expected:
                    digest.update(f"blob {expected['size']}\0".encode())
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > expected["size"]:
                        raise RuntimeError(
                            f"Oversized model artifact: {name}/{filename}"
                        )
                    digest.update(chunk)
                    output.write(chunk)
            wanted = (
                expected["lfs"]["sha256"] if "lfs" in expected else expected["blobId"]
            )
            if size != expected["size"] or digest.hexdigest() != wanted:
                target.unlink()
                raise RuntimeError(f"Model integrity mismatch: {name}/{filename}")
            print(f"Verified {name}/{filename}: {size} bytes", flush=True)


if __name__ == "__main__":
    main()
