"""A two-alternative scorer with a symmetric explicit no-match output."""
import torch
from torch import nn

from pair_review_features import SIDE_DIM


FORMAT = "four-layer-two-cue-review-v1"


class PairReviewer(nn.Module):
    def __init__(self):
        super().__init__()
        self.register_buffer("center",torch.zeros(SIDE_DIM))
        self.register_buffer("scale",torch.ones(SIDE_DIM))
        self.side = nn.Sequential(nn.Linear(SIDE_DIM,48),nn.LayerNorm(48),nn.GELU(),nn.Linear(48,32),nn.Tanh())
        self.match = nn.Sequential(nn.Linear(96,32),nn.GELU(),nn.Linear(32,1))
        self.empty = nn.Sequential(nn.Linear(65,24),nn.GELU(),nn.Linear(24,1))

    def forward(self, features, valid):
        x = ((features-self.center)/self.scale).clamp(-6.,6.)
        h = self.side(x)*valid[...,None]
        other = h.flip(1)
        scores = self.match(torch.cat((h,other,h-other),dim=-1)).squeeze(-1)
        n = valid.sum(1,keepdim=True).clamp_min(1)
        mean = h.sum(1)/n
        difference = (h[:,0]-h[:,1]).abs()
        none = self.empty(torch.cat((mean,difference,(n-1).to(mean.dtype)),dim=1))
        return (scores-none).masked_fill(~valid,-1e4)


def load_reviewer(path, parent_sha, ranker_sha, device):
    blob = torch.load(path,map_location="cpu",weights_only=True)
    if blob["format"]!=FORMAT or blob["parent_sha256"]!=parent_sha or blob["ranker_sha256"]!=ranker_sha:
        raise ValueError("Reviewer does not match the four-layer model and ranker")
    model = PairReviewer()
    model.load_state_dict(blob["state_dict"],strict=True)
    return model.to(device).eval(),blob["gates"]
