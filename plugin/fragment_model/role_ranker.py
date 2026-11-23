"""Supervised action and object scores for the existing four-layer reader."""
import math
import torch
from torch import nn

from role_evidence import ACTION_DIM, OBJECT_DIM, WHOLE_DIM


FORMAT = "four-layer-action-object-ranker-v1"
WIDTH = ACTION_DIM + OBJECT_DIM + WHOLE_DIM


class RoleRanker(nn.Module):
    def __init__(self):
        super().__init__()
        self.register_buffer("center",torch.zeros(WIDTH))
        self.register_buffer("scale",torch.ones(WIDTH))
        self.action = nn.Sequential(nn.Linear(ACTION_DIM,24),nn.Tanh(),nn.Linear(24,1))
        self.object = nn.Sequential(nn.Linear(OBJECT_DIM,32),nn.Tanh(),nn.Linear(32,1))
        self.whole = nn.Sequential(nn.Linear(WHOLE_DIM,12),nn.Tanh(),nn.Linear(12,1))
        self.joint = nn.Linear(WHOLE_DIM+2,1)

    def forward(self, features):
        normalized = ((features-self.center)/self.scale).clamp(-6,6)
        act,obj,whole = normalized.split((ACTION_DIM,OBJECT_DIM,WHOLE_DIM),dim=-1)
        a,o,w = features.split((ACTION_DIM,OBJECT_DIM,WHOLE_DIM),dim=-1)
        # These priors reflect the explicit linguistic features. Both role scores
        # also receive independent labels from the crossed examples during fitting.
        direction = self.action(act).squeeze(-1) + 2*a[...,0]+a[...,2]-3*a[...,3]-3*a[...,10]
        argument = self.object(obj).squeeze(-1) + 1.3*o[...,0]+1.3*o[...,11]-2*o[...,13]
        roles = torch.stack((direction,argument),dim=-1)
        both = math.log(2.)-torch.logsumexp(-roles,dim=-1)
        interaction = self.joint(torch.cat((whole,torch.tanh(roles/3)),dim=-1)).squeeze(-1)
        score = both+self.whole(whole).squeeze(-1)+.65*w[...,-1]+.8*torch.tanh(interaction)
        return score,roles


def load_ranker(path, parent_sha, device):
    saved = torch.load(path,map_location="cpu",weights_only=True)
    if saved["format"]!=FORMAT or saved["parent_sha256"]!=parent_sha:
        raise ValueError("Ranking weights do not match this four-layer model")
    net = RoleRanker()
    net.load_state_dict(saved["state_dict"],strict=True)
    return net.to(device).eval(),saved["gate"]
