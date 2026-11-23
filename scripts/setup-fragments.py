"""Prepare pinned E5/BGE assets and record the interpreter for the DSH plugin."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

MODEL = Path(__file__).resolve().parents[1] / "plugin" / "fragment_model"
sys.dont_write_bytecode = True
sys.path.insert(0, str(MODEL))
import fetch_assets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path(os.environ.get("DSH_HOME", Path.home() / ".dsh")))
    parser.add_argument("--assets-from", type=Path, help="existing fragment_association_base with pinned weights and tokenizer")
    args = parser.parse_args()
    directory = args.home.resolve() / "fragment-model"
    assets = directory / "assets"
    directory.mkdir(parents=True, exist_ok=True)
    if args.assets_from:
        assets = args.assets_from.resolve()
    else:
        fetch_assets.ROOT = assets
        fetch_assets.MODEL = assets / "weights/multilingual_e5_small"
        fetch_assets.PAIR_DIR = assets / "weights/bge_reranker_base"
        fetch_assets.main()
    os.environ["DSH_FRAGMENT_ASSETS"] = str(assets)
    import torch
    from semantic_encoder import E5Encoder, PairReranker
    E5Encoder()
    PairReranker()
    from four_layer import load_model
    load_model(MODEL / "weights/four_layer.pt", "cpu")
    with tempfile.NamedTemporaryFile("w", encoding="utf8", dir=directory, delete=False) as stream:
        json.dump({"python": sys.executable, "assets": str(assets)}, stream)
    os.replace(stream.name, directory / "runtime.json")
    print("Verified local fragment runtime:", directory / "runtime.json")


if __name__ == "__main__":
    main()
