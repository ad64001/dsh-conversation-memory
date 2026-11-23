"""Local, pinned sentence encoder for a fragment's cue text."""
from functools import lru_cache
from hashlib import file_digest
from math import exp
from pathlib import Path
import sys
import os

import numpy as np
import onnxruntime as ort


ROOT = Path(os.environ.get("DSH_FRAGMENT_ASSETS", Path(__file__).resolve().parent))
ASSET_PATH = ROOT / "weights" / "multilingual_e5_small"
TOKENIZER_PATH = ROOT / "vendor"
MODEL_FILE = "model_qint8_avx512_vnni.onnx"
ASSET_SHA256 = {
    MODEL_FILE: "dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88",
    "tokenizer.json": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
}
MAX_TOKENS = 128
PAIR_ASSET_PATH = ROOT / "weights" / "bge_reranker_base"
PAIR_MODEL_FILE = "model_int8.onnx"
PAIR_SHA256 = {
    PAIR_MODEL_FILE: "46a1bb4cf46ff1e300d27589d620141fbf04fc0eaf8e7bb6dea5e044475ff387",
    "tokenizer.json": "14917dd757b81bc44d4af6b028367351702656670c1954e055dabdfcf21593cf",
}


def sha256_file(path):
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def input_arrays(tokens, inputs):
    feeds = {
        "input_ids": np.asarray([tokens.ids], dtype=np.int64),
        "attention_mask": np.asarray([tokens.attention_mask], dtype=np.int64),
        "token_type_ids": np.asarray([tokens.type_ids], dtype=np.int64),
    }
    return {name: feeds[name] for name in inputs}


def load_local_assets(directory, hashes, model_file, output):
    directory = Path(directory)
    for name, expected in hashes.items():
        path = directory / name
        if not path.is_file():
            raise FileNotFoundError(f"Run tools/fetch_semantic_assets.py to install {path.name}")
        if sha256_file(path) != expected:
            raise ValueError(f"Unexpected encoder artifact: {path.name}")
    if str(TOKENIZER_PATH) not in sys.path:
        sys.path.insert(0, str(TOKENIZER_PATH))
    from tokenizers import Tokenizer, __version__
    if __version__ != "0.22.2":
        raise ValueError("Encoder expects the pinned tokenizers 0.22.2")
    tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
    ort.disable_telemetry_events()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.log_severity_level = 3
    session = ort.InferenceSession(str(directory / model_file), sess_options=options,
                                   providers=["CPUExecutionProvider"])
    inputs = {item.name for item in session.get_inputs()}
    if not {"input_ids", "attention_mask"} <= inputs <= {"input_ids", "attention_mask", "token_type_ids"}:
        raise ValueError("Unexpected pinned encoder inputs")
    if [result.name for result in session.get_outputs()] != [output]:
        raise ValueError("Unexpected pinned encoder outputs")
    return tokenizer, session, inputs


class E5Encoder:
    """Produces normalized 384-dimensional cue vectors. Only model assets are required."""

    def __init__(self, directory=ASSET_PATH):
        self.tokenizer, self.session, self.inputs = load_local_assets(
            directory, ASSET_SHA256, MODEL_FILE, "last_hidden_state"
        )
        self.tokenizer.enable_truncation(max_length=MAX_TOKENS)
        self._encode_cached = lru_cache(maxsize=1024)(self._encode)

    def encode(self, text):
        if type(text) is not str or not text.strip() or len(text) > 512:
            raise ValueError("Cue must be a nonempty string of at most 512 characters")
        return self._encode_cached(text.strip())

    def _encode(self, text):
        # E5 uses the same "query:" prefix on both inputs for symmetric similarity.
        tokens = self.tokenizer.encode("query: " + text)
        if len(tokens.ids) > MAX_TOKENS:
            raise ValueError(f"Cue exceeds {MAX_TOKENS} model tokens")
        hidden = self.session.run(["last_hidden_state"], input_arrays(tokens, self.inputs))[0][0]
        pooled = hidden[np.asarray(tokens.attention_mask, dtype=bool)].mean(axis=0)
        norm = float(np.linalg.norm(pooled))
        if pooled.shape != (384,) or not np.isfinite(norm) or norm == 0.0:
            raise ValueError("Encoder produced an invalid cue vector")
        vector = pooled / norm
        vector.setflags(write=False)
        return vector


class PairReranker:
    """Scores the query and stored cue jointly using the fixed BGE model."""

    def __init__(self, directory=PAIR_ASSET_PATH):
        self.tokenizer, self.session, self.inputs = load_local_assets(
            directory, PAIR_SHA256, PAIR_MODEL_FILE, "logits"
        )
        self.tokenizer.enable_truncation(max_length=256)
        self._score_cached = lru_cache(maxsize=4096)(self._score)

    def score(self, query, cue):
        return self._score_cached(query.strip(), cue.strip())

    def _score(self, query, cue):
        tokens = self.tokenizer.encode(query, pair=cue)
        if len(tokens.ids) > 256:
            raise ValueError("The pair exceeds 256 model tokens")
        logits = self.session.run(["logits"], input_arrays(tokens, self.inputs))[0]
        if logits.size != 1 or not np.isfinite(logits).all():
            raise ValueError("Reranker produced an invalid score")
        return 1.0 / (1.0 + exp(-max(-80.0, min(80.0, float(logits.item())))))
