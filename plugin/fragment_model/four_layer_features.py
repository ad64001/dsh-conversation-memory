"""Frozen cue features shared between training and journal inference."""
from functools import lru_cache

import numpy as np

from semantic_encoder import E5Encoder, MAX_TOKENS, input_arrays


class FragmentCueEncoder(E5Encoder):
    def __init__(self):
        super().__init__()
        self._slots = lru_cache(maxsize=2048)(self._extract)

    def _encode(self, text):
        return self._slots(text)[0]

    def features(self, text):
        self.encode(text)
        return self._slots(text.strip())

    def _extract(self, text):
        prefix = "query: "
        tokens = self.tokenizer.encode(prefix + text)
        if len(tokens.ids) > MAX_TOKENS:
            raise ValueError(f"Cue exceeds {MAX_TOKENS} encoder tokens")
        hidden = self.session.run(["last_hidden_state"], input_arrays(tokens, self.inputs))[0][0]
        pooled = hidden[np.asarray(tokens.attention_mask, dtype=bool)].mean(axis=0)
        content = hidden[[i for i, (_, end) in enumerate(tokens.offsets) if end > len(prefix)]]
        if not len(content):
            content = pooled[None]
        parts = [pooled]
        for i in range(4):
            start = i * len(content) // 4
            stop = max(start + 1, (i + 1) * len(content) // 4)
            parts.append(content[start:stop].mean(axis=0))
        vectors = np.stack(parts)
        lengths = np.linalg.norm(vectors, axis=1, keepdims=True)
        if vectors.shape != (5, 384) or not np.isfinite(lengths).all() or (lengths == 0).any():
            raise ValueError("Invalid cue features")
        vectors /= lengths
        vectors.setflags(write=False)
        return vectors
