"""Four causal Transformer blocks with one gated, single-fragment read."""
import math

import torch
from torch import nn
from torch.nn import functional as F


WIDTH = 256
CUE_SLOTS = 5
INPUT_WIDTH = 384
CHUNK = 32
EMPTY = 256
FORMAT = "four-layer-fragment-v1"


class FourLayerTransformer(nn.Module):
    def __init__(self):
        super().__init__()
        self.positions = nn.Embedding(64, WIDTH)
        self.roles = nn.Embedding(3, WIDTH)
        self.semantic = nn.Linear(INPUT_WIDTH, WIDTH)
        self.difference = nn.Linear(INPUT_WIDTH, WIDTH)
        self.comparison = nn.Linear(CUE_SLOTS * CUE_SLOTS + 1, WIDTH)
        self.bytes = nn.Embedding(257, WIDTH)
        self.byte_bias = nn.Parameter(torch.zeros(257))
        self.blocks = nn.ModuleList([
            nn.TransformerEncoderLayer(WIDTH, 4, 4 * WIDTH, dropout=0.0,
                                       batch_first=True, norm_first=True)
            for _ in range(4)
        ])
        self.read = nn.MultiheadAttention(WIDTH, 4, dropout=0.0, batch_first=True)
        self.read_gate = nn.Parameter(torch.tensor(0.0))
        self.norm = nn.LayerNorm(WIDTH)
        self.match = nn.Linear(WIDTH, 1)
        self.register_buffer("causal", torch.ones(64, 64, dtype=torch.bool).triu(1), persistent=False)
        # The byte positions in a record have a defined order, independent of its contents.
        self.register_buffer("alignment", 8.0 * torch.eye(CHUNK), persistent=False)
        nn.init.normal_(self.positions.weight, std=0.025)
        nn.init.normal_(self.roles.weight, std=0.025)
        nn.init.normal_(self.bytes.weight, std=0.25)
        nn.init.zeros_(self.match.weight)
        nn.init.zeros_(self.match.bias)
        with torch.no_grad():
            self.read.in_proj_weight[2 * WIDTH:].copy_(torch.eye(WIDTH))
            self.read.out_proj.weight.copy_(torch.eye(WIDTH))
            self.byte_bias[EMPTY] = 2.0
            for block in self.blocks:
                block.self_attn.out_proj.weight.mul_(0.12)
                block.linear2.weight.mul_(0.12)

    def _transform(self, states, payload=None, admitted=None):
        size = states.size(1)
        pos = self.positions.weight[:size]
        states = states + pos
        mask = self.causal[:size, :size]
        for index, block in enumerate(self.blocks):
            states = block(states, src_mask=mask)
            if index == 1 and payload is not None:
                keys = pos.expand(states.size(0), -1, -1)
                read, _ = self.read(states, keys, self.bytes(payload),
                                    attn_mask=self.alignment[:size, :size], need_weights=False)
                states = states + (8 * self.read_gate.tanh()) * read * admitted[:, None, None]
        return self.norm(states)

    def match_logits(self, query, candidate, lexical):
        # During selection the network receives cue descriptions only.
        cosine = query @ candidate.transpose(1, 2)
        interactions = torch.cat(((cosine.flatten(1) - 0.75) * 6, lexical[:, None]), dim=1)
        scale = math.sqrt(INPUT_WIDTH)
        query_tokens = self.semantic(query * scale) + self.roles.weight[0]
        candidate_tokens = self.semantic(candidate * scale) + self.roles.weight[1]
        difference = self.difference((query[:, 0] - candidate[:, 0]).abs() * scale)
        decision = self.comparison(interactions) + self.roles.weight[2]
        states = torch.cat((query_tokens, candidate_tokens, difference[:, None], decision[:, None]), dim=1)
        residual = self.match(self._transform(states)[:, -1]).squeeze(-1)
        return 30.0 * (cosine[:, 0, 0] - 0.82) + residual

    def read_logits(self, payload, admitted):
        # No answer bytes appear in the causal input. They enter only at block 2.
        states = self.positions.weight.new_zeros(payload.size(0), payload.size(1), WIDTH)
        readout = self._transform(states, payload, admitted)
        return F.linear(readout, self.bytes.weight, self.byte_bias)


class FourLayerWithActions(FourLayerTransformer):
    def __init__(self, aliases):
        super().__init__()
        from action_features import ActionFeatures
        self.action_features = ActionFeatures(aliases)
        self.fusion = nn.Linear(9, 1)

    @staticmethod
    def fusion_inputs(neural, cosine, lexical, actions):
        semantic = (cosine - .85) * 30
        return torch.cat((neural[:, None], semantic[:, None], lexical[:, None], actions,
                          (semantic * actions[:, 0])[:, None]), dim=1)

    def scored_pairs(self, query, candidate, lexical, actions):
        neural = self.match_logits(query, candidate, lexical)
        cosine = (query[:, 0] * candidate[:, 0]).sum(-1)
        return self.fusion(self.fusion_inputs(neural, cosine, lexical, actions)).squeeze(-1)


def load_model(path, device):
    saved = torch.load(path, map_location="cpu", weights_only=True)
    if saved["format"] == FORMAT:
        network = FourLayerTransformer()
    elif saved["format"] == FORMAT + "-actions":
        network = FourLayerWithActions(saved["aliases"])
    else:
        raise ValueError("Unsupported four-layer memory checkpoint")
    network.load_state_dict(saved["state_dict"], strict=True)
    network.to(device).eval()
    return network, saved["policy"]
