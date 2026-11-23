"""Install the pinned public encoder and tokenizer in this project."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
import subprocess
import sys
from tempfile import NamedTemporaryFile
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "weights" / "multilingual_e5_small"
REVISION = "6a0d452a575215f80b8f66276dd4ee5d504942c6"
REPOSITORY = f"https://huggingface.co/intfloat/multilingual-e5-small/resolve/{REVISION}/onnx/"
FILES = {
    "model_qint8_avx512_vnni.onnx": (
        118346824, "dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88"
    ),
    "tokenizer.json": (
        17082730, "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"
    ),
}
WHEEL = "tokenizers-0.22.2-cp39-abi3-win_amd64.whl"
WHEEL_SHA = "c9ea31edff2968b44a88f97d784c2f16dc0729b8b143ed004699ebca91f05c48"
PAIR_DIR = ROOT / "weights" / "bge_reranker_base"
PAIR_REVISION = "f131ae72114cb18333648a2ee6b0942849e8ab95"
PAIR_REPOSITORY = f"https://huggingface.co/onnx-community/bge-reranker-base-ONNX/resolve/{PAIR_REVISION}/"
PAIR_FILES = {
    "onnx/model_int8.onnx": (279252659, "46a1bb4cf46ff1e300d27589d620141fbf04fc0eaf8e7bb6dea5e044475ff387"),
    "tokenizer.json": (17082798, "14917dd757b81bc44d4af6b028367351702656670c1954e055dabdfcf21593cf"),
}


def checksum(path):
    with path.open("rb") as stream:
        from hashlib import file_digest
        return file_digest(stream, "sha256").hexdigest()


def fetch(url, path, expected, size):
    if path.is_file():
        if path.stat().st_size != size or checksum(path) != expected:
            raise ValueError(f"Existing asset is inconsistent with the pinned version: {path.name}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    h = sha256()
    count = 0
    with NamedTemporaryFile(dir=path.parent, prefix=".download-", delete=False) as tmp:
        staging = Path(tmp.name)
        try:
            with urlopen(Request(url, headers={"User-Agent": "FragmentModelAssetFetcher/1.0"}), timeout=30) as remote:
                for chunk in iter(lambda: remote.read(1024 * 1024), b""):
                    count += len(chunk)
                    if count > size:
                        raise ValueError(f"Download exceeds its declared size: {path.name}")
                    h.update(chunk)
                    tmp.write(chunk)
            if count != size or h.hexdigest() != expected:
                raise ValueError(f"Asset integrity check failed: {path.name}")
        except BaseException:
            tmp.close()
            staging.unlink(missing_ok=True)
            raise
    staging.rename(path)
    print(f"Verified {path.name} ({count} bytes)", flush=True)


def install_tokenizer():
    import json
    vendor = ROOT / "vendor"
    existing = vendor / "tokenizers-0.22.2.dist-info" / "METADATA"
    if existing.is_file():
        return
    with urlopen("https://pypi.org/pypi/tokenizers/0.22.2/json", timeout=15) as remote:
        manifest = json.load(remote)
    selected = next(item for item in manifest["urls"] if item["filename"] == WHEEL)
    if selected["digests"]["sha256"] != WHEEL_SHA:
        raise ValueError("Tokenizer wheel metadata differs from the pinned digest")
    wheel = vendor / "wheels" / WHEEL
    fetch(selected["url"], wheel, WHEEL_SHA, selected["size"])
    subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
                    "--no-deps", "--no-index", "--target", str(vendor), str(wheel)], check=True)


def main():
    with ThreadPoolExecutor(max_workers=4) as executor:
        workers = [executor.submit(fetch, REPOSITORY + name, MODEL / name, expected, size)
                   for name, (size, expected) in FILES.items()]
        workers.extend(executor.submit(fetch, PAIR_REPOSITORY + name, PAIR_DIR / Path(name).name, expected, size)
                       for name, (size, expected) in PAIR_FILES.items())
        workers.append(executor.submit(install_tokenizer))
        for worker in workers:
            worker.result()


if __name__ == "__main__":
    main()
